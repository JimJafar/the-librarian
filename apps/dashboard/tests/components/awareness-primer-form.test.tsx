// Primer admin field (spec 041 A1, repointed by rethink T11).
//
// The labelled textarea over vault/primer.md. Asserts: it pre-fills with the
// current primer; the hint names the storage (vault/primer.md), the delivery
// (on connect) and the 2 KB cap (so the operator understands its reach);
// editing + Save sends the new text to the action; an emptied textarea sends
// "" (which disables the primer); a failed save surfaces the error (incl. the
// server's over-2KB teaching message).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { AwarenessPrimerForm } = await import("@/components/settings/awareness-primer-form");

describe("AwarenessPrimerForm", () => {
  afterEach(() => vi.clearAllMocks());

  it("pre-fills the textarea with the current primer", () => {
    render(<AwarenessPrimerForm initial="Current primer text." onSave={vi.fn()} />);
    expect(screen.getByLabelText("Awareness primer text")).toHaveValue("Current primer text.");
  });

  it("hint names vault/primer.md, on-connect delivery, and the 2 KB cap", () => {
    render(<AwarenessPrimerForm initial="x" onSave={vi.fn()} />);
    expect(screen.getByText(/vault\/primer\.md/i)).toBeInTheDocument();
    expect(screen.getByText(/when an agent connects/i)).toBeInTheDocument();
    expect(screen.getByText(/2 KB/i)).toBeInTheDocument();
  });

  it("sends the edited primer to onSave and shows a saved status", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(<AwarenessPrimerForm initial="" onSave={onSave} />);

    await userEvent.type(screen.getByLabelText("Awareness primer text"), "New primer");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("New primer");
    await vi.waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
  });

  it("sends '' when the textarea is cleared (disables the primer)", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(<AwarenessPrimerForm initial="Some default primer." onSave={onSave} />);

    await userEvent.clear(screen.getByLabelText("Awareness primer text"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("");
  });

  it("surfaces the error from a failed save", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: false, error: "boom" });
    render(<AwarenessPrimerForm initial="x" onSave={onSave} />);

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(screen.getByText("Error: boom")).toBeInTheDocument());
  });
});
