import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("@/app/(memories)/actions", () => ({
  createMemoryAction: (...args: unknown[]) => createMock(...args),
}));

const { NewMemoryForm } = await import("@/components/memories/new-form");

describe("NewMemoryForm", () => {
  afterEach(() => createMock.mockReset());

  it("submits the form fields to createMemoryAction", async () => {
    createMock.mockResolvedValueOnce({ ok: true });
    const onSaved = vi.fn();
    render(<NewMemoryForm onSaved={onSaved} />);

    await userEvent.type(screen.getByLabelText("Title"), "Hello");
    await userEvent.type(screen.getByLabelText("Body"), "Hello body");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(createMock).toHaveBeenCalledTimes(1);
    const form = createMock.mock.calls[0]?.[0] as FormData;
    expect(form.get("title")).toBe("Hello");
    expect(form.get("body")).toBe("Hello body");
    // Defaults from the form's select elements.
    expect(form.get("category")).toBe("lessons");
    expect(form.get("visibility")).toBe("common");
    expect(form.get("scope")).toBe("global");

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("renders the error from a failed mutation and does not call onSaved", async () => {
    createMock.mockResolvedValueOnce({ ok: false, error: "boom" });
    const onSaved = vi.fn();
    render(<NewMemoryForm onSaved={onSaved} />);

    await userEvent.type(screen.getByLabelText("Title"), "X");
    await userEvent.type(screen.getByLabelText("Body"), "Y");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();
  });
});
