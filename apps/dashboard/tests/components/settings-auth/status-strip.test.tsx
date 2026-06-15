import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusStrip } from "@/components/settings/auth/status-strip";

describe("StatusStrip", () => {
  it("reads 'off, no methods' on a fresh install", () => {
    render(<StatusStrip enabled={false} methods={[]} ready={false} />);
    expect(screen.getByText(/Authentication off · No methods configured/)).toBeInTheDocument();
  });

  it("reads 'off, ready to enable' once any method is configured", () => {
    render(<StatusStrip enabled={false} methods={["password"]} ready={true} />);
    expect(screen.getByText(/ready to enable/)).toBeInTheDocument();
    expect(screen.getByText("Password")).toBeInTheDocument();
  });

  it("reads 'on' with method pills when enforced", () => {
    render(<StatusStrip enabled={true} methods={["password", "github"]} ready={true} />);
    expect(screen.getByText(/Authentication on · 2 methods configured/)).toBeInTheDocument();
    expect(screen.getByText("Password")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });
});
