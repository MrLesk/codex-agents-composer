import { useEffect, useState } from "react";
import { useForm, type UseFormRegister } from "react-hook-form";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { Link } from "react-router";
import type { MultiAgentSettings, UpdateSettingsInput } from "../types";
import { useManager } from "../context/ManagerContext";

interface SettingsFormValues {
  maxThreads: string;
  maxDepth: string;
  jobMaxRuntimeSeconds: string;
}

interface SettingsNumberFieldProps {
  field: keyof Pick<
    SettingsFormValues,
    "maxThreads" | "maxDepth" | "jobMaxRuntimeSeconds"
  >;
  label: string;
  description: string;
  maxValue?: number;
  error?: string;
  register: UseFormRegister<SettingsFormValues>;
}

function toFieldValue(value: number | null): string {
  return value == null ? "" : String(value);
}

function toFormValues(settings: MultiAgentSettings): SettingsFormValues {
  return {
    maxThreads: toFieldValue(settings.maxThreads),
    maxDepth: toFieldValue(settings.maxDepth),
    jobMaxRuntimeSeconds: toFieldValue(settings.jobMaxRuntimeSeconds),
  };
}

function parseOptionalPositiveInteger(value: string, maxValue?: number): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Values must be positive integers");
  }

  if (typeof maxValue === "number" && parsed > maxValue) {
    throw new Error(`Value must be between 1 and ${maxValue}`);
  }

  return parsed;
}

function validateOptionalPositiveInteger(label: string, maxValue?: number) {
  return (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return true;

    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return `${label} must be a positive integer`;
    }

    if (typeof maxValue === "number" && parsed > maxValue) {
      return `${label} must be between 1 and ${maxValue}`;
    }

    return true;
  };
}

function SettingsNumberField({
  field,
  label,
  description,
  maxValue,
  error,
  register,
}: SettingsNumberFieldProps) {
  return (
    <div className="grid gap-3 rounded-xl border border-gray-800 bg-[#121212] p-4 md:grid-cols-[minmax(0,1fr)_180px] md:items-center">
      <div className="min-w-0">
        <p className="text-sm text-gray-100">{label}</p>
        <p className="mt-1 text-xs leading-5 text-gray-500">{description}</p>
      </div>

      <div>
        <input
          type="number"
          min="1"
          max={maxValue}
          inputMode="numeric"
          placeholder="Use Codex default"
          className="w-full rounded-lg border border-gray-800 bg-[#0d0d0d] px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:border-blue-500/50 focus:outline-none"
          {...register(field, {
            validate: validateOptionalPositiveInteger(label, maxValue),
          })}
        />
        {error ? <p className="mt-1.5 text-xs text-red-300">{error}</p> : null}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { settings, saveSettings } = useManager();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<SettingsFormValues>({
    defaultValues: {
      maxThreads: "",
      maxDepth: "",
      jobMaxRuntimeSeconds: "",
    },
  });

  useEffect(() => {
    if (!settings) return;

    reset(toFormValues(settings));
    setSaveError(null);
    setSaveSuccess(null);
  }, [reset, settings]);
  const onSubmit = async (values: SettingsFormValues) => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const input: UpdateSettingsInput = {
        maxThreads: parseOptionalPositiveInteger(values.maxThreads, 12),
        maxDepth: parseOptionalPositiveInteger(values.maxDepth, 4),
        jobMaxRuntimeSeconds: parseOptionalPositiveInteger(values.jobMaxRuntimeSeconds),
      };

      const nextSettings = await saveSettings(input);
      reset(toFormValues(nextSettings));
      setSaveSuccess("Settings saved to your Codex config.");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <section className="p-7 md:p-9 max-w-4xl mx-auto">
        <div className="rounded-2xl border border-gray-800 bg-[#101010] p-6 text-sm text-gray-400">
          Loading settings...
        </div>
      </section>
    );
  }

  return (
    <section className="p-7 md:p-9 max-w-4xl mx-auto">
      <div className="mb-7">
        <Link
          to="/"
          className="text-xs text-gray-400 hover:text-gray-200 inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to catalog
        </Link>
        <h1 className="mt-4 text-2xl text-gray-100">Agent Settings</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
          Control the Codex config values used for agent orchestration. Leave
          numeric fields blank to fall back to Codex defaults.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <section className="rounded-2xl border border-gray-800 bg-[#101010] p-5">
          <div className="mb-4">
            <h2 className="text-base text-gray-100">Agent Limits</h2>
            <p className="mt-1 text-sm leading-6 text-gray-500">
              These values map to the top-level `agents` config block used by Codex.
            </p>
          </div>

          <div className="space-y-4">
            <SettingsNumberField
              field="maxThreads"
              label="agents.max_threads"
              description="Caps how many agent tasks Codex can run at the same time. Valid range: 1-12."
              maxValue={12}
              error={errors.maxThreads?.message}
              register={register}
            />
            <SettingsNumberField
              field="maxDepth"
              label="agents.max_depth"
              description="Limits how many levels deep an agent can recursively spawn more agents. Valid range: 1-4."
              maxValue={4}
              error={errors.maxDepth?.message}
              register={register}
            />
            <SettingsNumberField
              field="jobMaxRuntimeSeconds"
              label="agents.job_max_runtime_seconds"
              description="Sets the maximum runtime budget for each spawned agent job before it is failed."
              error={errors.jobMaxRuntimeSeconds?.message}
              register={register}
            />
          </div>
        </section>

        {saveError ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {saveError}
          </div>
        ) : null}

        {saveSuccess ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            {saveSuccess}
          </div>
        ) : null}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving || !isDirty}
            className="inline-flex items-center gap-2 rounded-lg border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-sm text-blue-200 transition-colors hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-[#121212] disabled:text-gray-500"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Settings
          </button>
        </div>
      </form>
    </section>
  );
}
