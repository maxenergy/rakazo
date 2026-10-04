import type { UiLocale } from "@rakazo/contracts";

const PROGRESS_COPY: Record<UiLocale, { starting: string; using: (tool: string) => string }> = {
  en: { starting: "starting…", using: (tool) => `using ${tool}…` },
  "zh-CN": { starting: "正在启动…", using: (tool) => `正在使用 ${tool}…` },
  de: { starting: "Wird gestartet…", using: (tool) => `${tool} wird verwendet…` },
  es: { starting: "Iniciando…", using: (tool) => `Usando ${tool}…` },
  fr: { starting: "Démarrage…", using: (tool) => `Utilisation de ${tool}…` },
  hi: { starting: "शुरू हो रहा है…", using: (tool) => `${tool} का उपयोग हो रहा है…` },
  ko: { starting: "시작 중…", using: (tool) => `${tool} 사용 중…` },
  "pt-BR": { starting: "Iniciando…", using: (tool) => `Usando ${tool}…` },
  ru: { starting: "Запуск…", using: (tool) => `Используется ${tool}…` },
  tr: { starting: "Başlatılıyor…", using: (tool) => `${tool} kullanılıyor…` },
};

/** Translate runtime-authored progress while preserving model output and tool identifiers. */
export function localizeSubagentProgress(progress: string, locale: UiLocale): string {
  const copy = PROGRESS_COPY[locale];
  if (progress === "starting…") return copy.starting;
  const tool = /^using (.+)…$/.exec(progress)?.[1];
  return tool ? copy.using(tool) : progress;
}
