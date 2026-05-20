import { ThemeToggle } from "@/components/theme-toggle";

export default function Page() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <header className="flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Hello Librarian</h1>
        <ThemeToggle />
      </header>
      <p className="max-w-2xl text-muted-foreground">
        Next.js 15 + Tailwind v4 + shadcn/ui scaffold for the Librarian admin dashboard. The real
        surfaces land in T6.2 onwards.
      </p>
    </main>
  );
}
