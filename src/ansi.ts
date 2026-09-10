/**
 * 색은 **표현 계층**이다. 렌더러는 상태·판정·집계를 만들고, 이 모듈은 그 위에 색만
 * 얹는다. 색을 끄면 문자열이 그대로 남아야 하므로, 모든 상태는 색 없이도 기호와
 * 단어로 구별된다(WCAG 2.2 1.4.1 — 색만으로 정보를 전달하지 않는다).
 *
 * 런타임 의존성 0 을 지키기 위해 SGR 코드를 직접 쓴다.
 */
import type { ColorMode } from './config.ts';

export interface Paint {
  enabled: boolean;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}

const ESC = '\x1b[';
const sgr = (open: number, close: number, enabled: boolean) => (s: string) =>
  enabled ? `${ESC}${open}m${s}${ESC}${close}m` : s;

export function paint(enabled: boolean): Paint {
  return {
    enabled,
    green: sgr(32, 39, enabled),
    red: sgr(31, 39, enabled),
    yellow: sgr(33, 39, enabled),
    cyan: sgr(36, 39, enabled),
    dim: sgr(2, 22, enabled),
    bold: sgr(1, 22, enabled),
  };
}

export interface ColorEnv {
  /** 명시 플래그(`--color`). 가장 세다 — no-color.org 도 명시 플래그가 환경을 이긴다고 정한다. */
  flag?: ColorMode;
  /** 설정(`output.color`). 플래그 다음이다. */
  config?: ColorMode;
  /** `process.env.NO_COLOR`. 값이 비어 있지 않으면 `auto` 에서 색을 끈다. */
  noColor?: string | undefined;
  /** stdout 이 TTY 인가. `auto` 의 마지막 판단 근거다. */
  isTTY: boolean;
}

/**
 * `auto` 의 판단 순서: 플래그 → 설정 → `NO_COLOR` → TTY. `always`/`never` 는 어느
 * 단계에서 나오든 그 자리에서 결정된다. 파이프·훅·CI 는 TTY 가 아니므로 기본값에서
 * 색이 없고, LLM 이 읽는 출력에 제어 문자가 섞이지 않는다.
 */
export function resolveColor(env: ColorEnv): boolean {
  for (const mode of [env.flag, env.config]) {
    if (mode === 'always') return true;
    if (mode === 'never') return false;
  }
  if (env.noColor != null && env.noColor !== '') return false;
  return env.isTTY;
}

/** 어떤 색 설정에서든 JSON 이 깨끗한지 검사하는 데 쓴다. */
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
