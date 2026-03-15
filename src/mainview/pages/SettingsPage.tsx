import { useEffect, useState } from "react";
import { useForm, type UseFormRegister } from "react-hook-form";
import { Loader2, Save, Settings2 } from "lucide-react";
import type { MultiAgentSettings, UpdateSettingsInput } from "../types";
import { useManager } from "../context/ManagerContext";

interface SettingsFormValues {
  multiAgentEnabled: boolean;
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
    multiAgentEnabled: settings.multiAgentEnabled,
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
    watch,
    formState: { errors, isDirty },
  } = useForm<SettingsFormValues>({
    defaultValues: {
      multiAgentEnabled: false,
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

  const multiAgentEnabled = watch("multiAgentEnabled");

  const onSubmit = async (values: SettingsFormValues) => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const input: UpdateSettingsInput = {
        multiAgentEnabled: values.multiAgentEnabled,
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
        <div className="inline-flex items-center gap-2 rounded-full border border-gray-800 bg-[#121212] px-3 py-1 text-xs text-gray-400">
          <Settings2 className="h-3.5 w-3.5" />
          Settings
        </div>
        <h1 className="mt-4 text-2xl text-gray-100">Multi-Agent Settings</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
          Control the Codex config values used for multi-agent orchestration. Leave
          numeric fields blank to fall back to Codex defaults.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <section className="rounded-2xl border border-gray-800 bg-[#101010] p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="max-w-2xl">
              <h2 className="text-base text-gray-100">Enable Multi-Agent Mode</h2>
              <p className="mt-1 text-sm leading-6 text-gray-500">
                Turns `features.multi_agent` on or off. When disabled, the app
                will stop offering the “New Agent” action but will still show any
                existing agents.
              </p>
            </div>

            <label className="inline-flex cursor-pointer items-center gap-3 self-start md:self-center">
              <span className="text-sm text-gray-300">
                {multiAgentEnabled ? "On" : "Off"}
              </span>
              <span className="relative inline-flex h-7 w-12 items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  {...register("multiAgentEnabled")}
                />
                <span className="absolute inset-0 rounded-full bg-gray-700 transition peer-checked:bg-blue-500/80" />
                <span className="absolute left-1 h-5 w-5 rounded-full bg-white transition peer-checked:translate-x-5" />
              </span>
            </label>
          </div>
        </section>

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
