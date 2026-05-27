// T4.1 — DomainList component tests.
//
// Covers the add → optimistic-render flow and the confirmation-guarded
// remove flow. The floor domain (`general`) renders the Remove button
// disabled so the owner can't accidentally hit it.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addMock = vi.fn();
const removeMock = vi.fn();
const confirmMock = vi.fn();

vi.mock("@/app/(memories)/domains/actions", () => ({
  addDomainAction: (...args: unknown[]) => addMock(...args),
  removeDomainAction: (...args: unknown[]) => removeMock(...args),
}));

const { DomainList } = await import("@/components/domains/domain-list");

beforeEach(() => {
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  addMock.mockReset();
  removeMock.mockReset();
  confirmMock.mockReset();
  vi.unstubAllGlobals();
});

const initial = [
  { name: "coding", created_at: "2026-05-27T00:00:00.000Z", memory_count: 3 },
  { name: "general", created_at: "2026-05-27T00:00:00.000Z", memory_count: 7 },
];

describe("DomainList", () => {
  it("renders each domain with its memory_count and disables Remove on `general`", () => {
    render(<DomainList initial={initial} />);
    expect(screen.getByText("coding")).toBeInTheDocument();
    expect(screen.getByText("general")).toBeInTheDocument();
    expect(screen.getByText("3 memories")).toBeInTheDocument();
    expect(screen.getByText("7 memories")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove general")).toBeDisabled();
    expect(screen.getByLabelText("Remove coding")).toBeEnabled();
  });

  it("submits the add form and optimistically renders the new domain", async () => {
    addMock.mockResolvedValueOnce({ ok: true });
    render(<DomainList initial={initial} />);
    await userEvent.type(screen.getByLabelText("New domain name"), "family-admin");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(addMock).toHaveBeenCalledTimes(1);
    const form = addMock.mock.calls[0]?.[0] as FormData;
    expect(form.get("name")).toBe("family-admin");
    await vi.waitFor(() => expect(screen.getByText("family-admin")).toBeInTheDocument());
  });

  it("renders the server error when add fails", async () => {
    addMock.mockResolvedValueOnce({ ok: false, error: "already exists" });
    render(<DomainList initial={initial} />);
    await userEvent.type(screen.getByLabelText("New domain name"), "coding");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await vi.waitFor(() => expect(screen.getByText("already exists")).toBeInTheDocument());
  });

  it("removes a domain after explicit confirmation", async () => {
    confirmMock.mockReturnValueOnce(true);
    removeMock.mockResolvedValueOnce({ ok: true });
    render(<DomainList initial={initial} />);
    await userEvent.click(screen.getByLabelText("Remove coding"));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith("coding");
    await vi.waitFor(() => expect(screen.queryByText("coding")).not.toBeInTheDocument());
  });

  it("does not call the action when the user cancels the confirm", async () => {
    confirmMock.mockReturnValueOnce(false);
    render(<DomainList initial={initial} />);
    await userEvent.click(screen.getByLabelText("Remove coding"));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.getByText("coding")).toBeInTheDocument();
  });
});
