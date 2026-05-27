import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClassifierEvalSoftAlert } from "@/components/classifier-eval/soft-alert-banner";

describe("ClassifierEvalSoftAlert", () => {
  it("renders nothing when the threshold is not exceeded", () => {
    const { container } = render(
      <ClassifierEvalSoftAlert
        alert={{
          maxRetriesCount: 5,
          windowSize: 100,
          rate: 0.05,
          exceedsThreshold: false,
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the banner when the threshold is exceeded", () => {
    render(
      <ClassifierEvalSoftAlert
        alert={{
          maxRetriesCount: 25,
          windowSize: 100,
          rate: 0.25,
          exceedsThreshold: true,
        }}
      />,
    );
    expect(screen.getByText(/Elevated max-retries rate/)).toBeInTheDocument();
    expect(screen.getByText(/25 of the last 100/)).toBeInTheDocument();
    expect(screen.getByText(/\(25%\)/)).toBeInTheDocument();
  });
});
