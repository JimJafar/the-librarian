// GitHub Releases BackupTarget (automated-backups A2). A backup bundle is a
// GitHub Release (tag = bundle name) with the bundle's files attached as release
// ASSETS — assets live in GitHub's blob storage, not the git object database, so
// each backup is an independent, deletable snapshot (no history rewrite, no bloat).
//
// Uses Node's global `fetch` — no SDK dependency. The bearer token lives only in
// request headers; it never appears in URLs, logs, or error messages, and every
// token-bearing call to api.github.com uses `redirect: "error"` so a 3xx can't
// carry it cross-origin. (The one exception — asset download — is documented at
// its call site.)
//
// Object keys follow the bundle convention `<bundleName>/<file>` used by
// syncBundle/fetchBundle: the bundle is the tag, the file is the asset name.

import type { GithubSyncConfig } from "./github-config.js";
import type { BackupTarget } from "./types.js";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
// Only Releases whose tag carries this prefix are treated as Librarian backups, so
// the target never lists or deletes unrelated Releases in a shared repo.
const BACKUP_TAG_PREFIX = "librarian-backup-";

interface GithubAsset {
  id: number;
  name: string;
}
interface GithubRelease {
  id: number;
  tag_name: string;
  assets?: GithubAsset[];
}

/** Split a `<bundleName>/<file>` key into its two parts. */
function splitKey(name: string): [bundle: string, file: string] {
  const i = name.indexOf("/");
  if (i <= 0 || i === name.length - 1) {
    throw new Error(`expected a "<bundle>/<file>" key, got ${JSON.stringify(name)}`);
  }
  return [name.slice(0, i), name.slice(i + 1)];
}

export function createGithubTarget(config: GithubSyncConfig): BackupTarget {
  const slash = config.repo.indexOf("/");
  if (slash <= 0 || slash !== config.repo.lastIndexOf("/") || slash === config.repo.length - 1) {
    throw new Error(`invalid GitHub repo ${JSON.stringify(config.repo)} — expected "owner/repo"`);
  }
  const repoPath = `${API}/repos/${config.repo}`;
  const uploadPath = `${UPLOADS}/repos/${config.repo}`;
  const authHeaders: Record<string, string> = {
    authorization: `Bearer ${config.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "the-librarian-backup",
  };

  // A token-bearing api.github.com request. redirect:"error" keeps a 3xx from
  // carrying the bearer token to another origin.
  function api(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      redirect: "error",
      headers: { ...authHeaders, ...(init.headers as Record<string, string> | undefined) },
    });
  }

  // Throw a teaching error WITHOUT the token. GitHub never echoes the
  // Authorization header, so a short slice of the body is safe and informative.
  async function ensureOk(res: Response, action: string): Promise<Response> {
    if (res.ok) return res;
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300).replace(/\s+/g, " ").trim();
    } catch {
      // body already consumed / unreadable — status alone teaches enough
    }
    throw new Error(`GitHub ${action} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }

  // The common path: call and throw a teaching error on any non-2xx.
  async function apiOk(url: string, init: RequestInit, action: string): Promise<Response> {
    return ensureOk(await api(url, init), action);
  }

  async function getRelease(tag: string): Promise<GithubRelease | null> {
    const res = await api(`${repoPath}/releases/tags/${encodeURIComponent(tag)}`);
    if (res.status === 404) return null;
    await ensureOk(res, "release lookup");
    return (await res.json()) as GithubRelease;
  }

  async function ensureRelease(tag: string): Promise<GithubRelease> {
    const existing = await getRelease(tag);
    if (existing) return existing;
    const res = await apiOk(
      `${repoPath}/releases`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag_name: tag, name: tag }),
      },
      "release create",
    );
    return (await res.json()) as GithubRelease;
  }

  return {
    async put(name, data) {
      const [bundle, file] = splitKey(name);
      const release = await ensureRelease(bundle);
      // Assets are immutable, so overwriting means delete-then-upload.
      const existing = (release.assets ?? []).find((a) => a.name === file);
      if (existing) {
        await apiOk(
          `${repoPath}/releases/assets/${existing.id}`,
          { method: "DELETE" },
          "asset delete (overwrite)",
        );
      }
      const url = `${uploadPath}/releases/${release.id}/assets?name=${encodeURIComponent(file)}`;
      await apiOk(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: data,
        },
        "asset upload",
      );
    },

    async get(name) {
      const [bundle, file] = splitKey(name);
      const release = await getRelease(bundle);
      const asset = release && (release.assets ?? []).find((a) => a.name === file);
      if (!asset) throw new Error(`no asset ${JSON.stringify(file)} in backup ${bundle}`);
      // The asset endpoint 302-redirects to a presigned storage URL. We follow it
      // (redirect:"follow"): per the fetch spec the Authorization header is dropped
      // on the cross-origin hop, so the token never reaches the storage host, and
      // the presigned URL needs no auth. This is the one call that follows redirects.
      const res = await fetch(`${repoPath}/releases/assets/${asset.id}`, {
        redirect: "follow",
        headers: { ...authHeaders, accept: "application/octet-stream" },
      });
      await ensureOk(res, "asset download");
      return Buffer.from(await res.arrayBuffer());
    },

    async list(prefix = "") {
      // Retention keeps a small number of bundles, so one page (100) is ample;
      // assets are returned inline with each release.
      const res = await apiOk(`${repoPath}/releases?per_page=100`, {}, "release list");
      const releases = (await res.json()) as GithubRelease[];
      const keys: string[] = [];
      for (const release of releases) {
        if (
          typeof release.tag_name !== "string" ||
          !release.tag_name.startsWith(BACKUP_TAG_PREFIX)
        ) {
          continue; // not one of ours
        }
        for (const asset of release.assets ?? []) {
          keys.push(`${release.tag_name}/${asset.name}`);
        }
      }
      return keys.filter((k) => k.startsWith(prefix)).sort();
    },

    async deleteBundle(bundleName) {
      const release = await getRelease(bundleName);
      if (release) {
        await apiOk(`${repoPath}/releases/${release.id}`, { method: "DELETE" }, "release delete");
      }
      // Deleting a Release leaves its tag ref behind — remove it too, or retention
      // would prune Releases while orphan tags accumulate. 404/422 = already gone.
      const tagRes = await api(`${repoPath}/git/refs/tags/${encodeURIComponent(bundleName)}`, {
        method: "DELETE",
      });
      if (!tagRes.ok && tagRes.status !== 404 && tagRes.status !== 422) {
        await ensureOk(tagRes, "tag delete");
      }
    },
  };
}
