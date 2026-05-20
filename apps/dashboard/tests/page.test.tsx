import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Page from "../app/page";

describe("apps/dashboard/app/page.tsx", () => {
  it('renders the "Hello Librarian" placeholder', () => {
    const html = renderToString(<Page />);
    expect(html).toMatch(/Hello Librarian/);
  });
});
