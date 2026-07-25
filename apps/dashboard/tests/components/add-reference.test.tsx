import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Add-reference affordance (spec 073 T5, SC 7). The server action is mocked
// so this stays a component-only check — the server behaviour has its own tests
// in packages/mcp-server (add-reference.test.ts).

// jsdom does not implement Blob/File.text(), which is a standard, widely
// available browser API. Shim it here rather than making the component use
// FileReader — the product code should target the platform, not the test
// environment's gaps.
if (typeof File !== "undefined" && File.prototype.text === undefined) {
  Object.defineProperty(File.prototype, "text", {
    configurable: true,
    value(this: File) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    },
  });
}

const addReferenceAction = vi.fn();

vi.mock("@/app/(memories)/actions", () => ({
  addReferenceAction: (...args: unknown[]) => addReferenceAction(...args),
}));

const { AddReferenceDialog } = await import("@/components/memories/add-reference-dialog");

beforeEach(() => {
  addReferenceAction.mockReset().mockResolvedValue({ ok: true, path: "references/filed.md" });
});

const openDialog = () => {
  render(<AddReferenceDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Add reference" }));
};

describe("AddReferenceDialog — filing by URL", () => {
  it("sends the URL", async () => {
    openDialog();
    fireEvent.change(screen.getByLabelText(/Page URL/i), {
      target: { value: "https://example.com/spec" },
    });
    fireEvent.click(screen.getByRole("button", { name: /File reference/ }));

    await waitFor(() =>
      expect(addReferenceAction).toHaveBeenCalledWith({ url: "https://example.com/spec" }),
    );
  });

  it("will not submit an empty URL", () => {
    openDialog();
    expect(screen.getByRole("button", { name: /File reference/ })).toBeDisabled();
  });
});

describe("AddReferenceDialog — filing Markdown", () => {
  const switchToPaste = () =>
    fireEvent.click(screen.getByRole("button", { name: /Paste or upload Markdown/ }));

  it("sends pasted content", async () => {
    openDialog();
    switchToPaste();
    fireEvent.change(screen.getByLabelText(/^Markdown$/i), {
      target: { value: "# Deploy policy\n\nNever on a Friday." },
    });
    fireEvent.click(screen.getByRole("button", { name: /File reference/ }));

    await waitFor(() =>
      expect(addReferenceAction).toHaveBeenCalledWith({
        content: "# Deploy policy\n\nNever on a Friday.",
      }),
    );
  });

  it("sends a title when one is given", async () => {
    openDialog();
    switchToPaste();
    fireEvent.change(screen.getByLabelText(/Title/i), { target: { value: "Runbook" } });
    fireEvent.change(screen.getByLabelText(/^Markdown$/i), { target: { value: "no heading" } });
    fireEvent.click(screen.getByRole("button", { name: /File reference/ }));

    await waitFor(() =>
      expect(addReferenceAction).toHaveBeenCalledWith({ content: "no heading", title: "Runbook" }),
    );
  });

  // The file is read in the browser and submitted as text, so choosing a file
  // and pasting its contents reach the server by exactly the same path — no
  // upload endpoint, no multipart.
  it("reads a chosen .md file into the same text submission", async () => {
    openDialog();
    switchToPaste();
    const file = new File(["# From disk\n\nbody"], "from-disk.md", { type: "text/markdown" });

    fireEvent.change(screen.getByLabelText(/Choose a Markdown file/i), {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect((screen.getByLabelText(/^Markdown$/i) as HTMLTextAreaElement).value).toContain(
        "From disk",
      ),
    );
    // The filename seeds the title, minus its extension.
    expect((screen.getByLabelText(/Title/i) as HTMLInputElement).value).toBe("from-disk");
  });
});

describe("AddReferenceDialog — outcomes", () => {
  it("shows the server's refusal instead of pretending it worked", async () => {
    addReferenceAction.mockResolvedValue({ ok: false, error: "Could not capture — blocked host" });
    openDialog();
    fireEvent.change(screen.getByLabelText(/Page URL/i), {
      target: { value: "http://127.0.0.1/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /File reference/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("blocked host");
  });

  it("reports the path it filed", async () => {
    openDialog();
    fireEvent.change(screen.getByLabelText(/Page URL/i), {
      target: { value: "https://example.com/spec" },
    });
    fireEvent.click(screen.getByRole("button", { name: /File reference/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("references/filed.md");
  });

  it("tells the parent so the panel can refresh", async () => {
    const onFiled = vi.fn();
    render(<AddReferenceDialog onFiled={onFiled} />);
    fireEvent.click(screen.getByRole("button", { name: "Add reference" }));
    fireEvent.change(screen.getByLabelText(/Page URL/i), {
      target: { value: "https://example.com/spec" },
    });
    fireEvent.click(screen.getByRole("button", { name: /File reference/ }));

    await waitFor(() => expect(onFiled).toHaveBeenCalledWith("references/filed.md"));
  });
});
