import { claimClientKey, redeemClaim } from "@/lib/claim-redemption";

const GENERIC_REFUSAL = "claim invalid, already used, or not armed";
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  if (request.body === null) return {};

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    raw += decoder.decode(chunk.value, { stream: true });
  }
  raw += decoder.decode();
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError("claim body must be an object");
  }
  return parsed as Record<string, unknown>;
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (error) {
    const status = error instanceof BodyTooLargeError ? 413 : 400;
    return Response.json(
      { status: "error", error: GENERIC_REFUSAL },
      { status, headers: { "cache-control": "no-store" } },
    );
  }

  const result = await redeemClaim(
    { token: body.token, password: body.password, confirm: body.confirm },
    claimClientKey(request.headers),
  );
  const status = result.status === "error" ? (result.httpStatus ?? 400) : 200;
  return Response.json(result, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
