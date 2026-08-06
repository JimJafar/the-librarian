"use client";

import type { ChronicleConfig, ChronicleConfigPatch, ChronicleDay } from "@librarian/core";
import { CHRONICLE_DAYS } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SaveConfigResult } from "@/app/curator/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { Select } from "@/components/ui-v2/select";

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function ChronicleConfigForm({
  initial,
  onSave,
}: {
  initial: ChronicleConfig;
  onSave: (patch: ChronicleConfigPatch) => Promise<SaveConfigResult>;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [dayOfWeek, setDayOfWeek] = useState<ChronicleDay>(initial.dayOfWeek);
  const [scheduleTime, setScheduleTime] = useState(initial.scheduleTime);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(id);
  }, [saved]);

  const clearStatus = () => {
    setSaved(false);
    setError(null);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    clearStatus();
    if (!TIME_PATTERN.test(scheduleTime)) {
      setError("Choose a valid time in 24-hour HH:MM format.");
      return;
    }
    startTransition(async () => {
      const result = await onSave({ enabled, dayOfWeek, scheduleTime });
      if (result.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-5"
      aria-label="Chronicle schedule"
      noValidate
    >
      <label className="inline-flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            clearStatus();
          }}
          className="h-4 w-4 accent-ink-accent"
        />
        Enable scheduled Chronicle
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor="chronicle-weekday">
            Weekday
          </SectionLabel>
          <Select
            id="chronicle-weekday"
            value={dayOfWeek}
            onChange={(event) => {
              setDayOfWeek(event.target.value as ChronicleDay);
              clearStatus();
            }}
          >
            {CHRONICLE_DAYS.map((day) => (
              <option key={day} value={day}>
                {day[0]!.toUpperCase() + day.slice(1)}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor="chronicle-time">
            Time
          </SectionLabel>
          <Input
            id="chronicle-time"
            type="time"
            className="w-32"
            value={scheduleTime}
            onChange={(event) => {
              setScheduleTime(event.target.value);
              clearStatus();
            }}
          />
        </div>
      </div>

      <p className="text-xs text-foreground/60">
        Runs once a week in the server&apos;s local time. A missed run catches up on the next poll.
      </p>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Error: {error}
        </p>
      ) : null}
      {saved ? (
        <p
          role="status"
          className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          Saved.
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="self-start" disabled={pending}>
        {pending ? "Saving…" : "Save schedule"}
      </Button>
    </form>
  );
}
