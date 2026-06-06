// Awareness-primer admin field (spec 041 PR-1 / Task A1).
//
// The labelled textarea for the server-sourced primer. Asserts: it pre-fills with
// the current primer; the hint says the text is injected EVERY TURN ON EVERY
// HARNESS (so the operator understands its reach); editing + Save sends the new
// text to the action; an emptied textarea sends "" (which disables the primer);
// a failed save surfaces the error.

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

  it("hint says the primer is injected every turn on every harness", () => {
    render(<AwarenessPrimerForm initial="x" onSave={vi.fn()} />);
    expect(screen.getByText(/injected every turn on every harness/i)).toBeInTheDocument();
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
