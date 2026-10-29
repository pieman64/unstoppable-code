import type { JSX, SVGProps } from 'react';
import {
  BuildingIcon,
  TerminalIcon,
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
  DeepSeekIcon,
  GitHubIcon,
  MiniMaxIcon,
  MoonshotIcon,
  OllamaIcon,
  ZaiIcon,
} from '../icons/AppIcons';
import { ClaudeLogo, CodexLogo, CursorLogo, OllamaLogo } from '../icons';

export interface ModelProviderIconProps extends SVGProps<SVGSVGElement> {
  provider: string;
  /** Use the compact glyphs instead of the full provider marks. */
  central?: boolean;
  /**
   * Compact glyphs size from `size`. `width` and `height` only affect the
   * full provider marks.
   */
  size?: number;
  /**
   * Renders compact glyphs at exactly `size`, skipping the Lucide 14px /
   * 20px tiers, so they match brand marks in a one-size surface.
   */
  exactSize?: boolean;
}

/** Canonical provider-to-glyph dispatch shared by every model surface. */
export function ModelProviderIcon({
  provider,
  central = false,
  size,
  exactSize = false,
  ...svgProps
}: ModelProviderIconProps): JSX.Element | null {
  const centralProps = {
    ...svgProps,
    ...(size === undefined ? {} : { size }),
    ...(exactSize ? { exactSize } : {}),
  };
  // An organization's own models group under `org-gateway:<id>`; a neutral
  // building stands for the organization rather than a guessed initial.
  if (provider.startsWith('org-gateway:')) {
    return <BuildingIcon {...centralProps} />;
  }
  switch (provider) {
    case 'anthropic':
    case 'claude':
      return central ? (
        <ClaudeIcon {...centralProps} />
      ) : (
        <ClaudeLogo {...svgProps} />
      );
    case 'openai':
    case 'codex':
      return central ? (
        <CodexIcon {...centralProps} />
      ) : (
        <CodexLogo {...svgProps} />
      );
    case 'opencode':
      return <TerminalIcon {...centralProps} />;
    case 'copilot':
      return <GitHubIcon {...centralProps} />;
    case 'cursor':
      return central ? (
        <CursorIcon {...centralProps} />
      ) : (
        <CursorLogo {...svgProps} />
      );
    case 'ollama':
      return central ? (
        <OllamaIcon {...centralProps} />
      ) : (
        <OllamaLogo {...svgProps} />
      );
    case 'deepseek':
      return <DeepSeekIcon {...centralProps} />;
    case 'moonshot':
    case 'kimi':
      return <MoonshotIcon {...centralProps} />;
    case 'minimax':
      return <MiniMaxIcon {...centralProps} />;
    case 'zai':
    case 'z.ai':
      return <ZaiIcon {...centralProps} />;
    default:
      return (
        <svg
          {...svgProps}
          viewBox="0 0 16 16"
          aria-hidden="true"
          data-generic-provider-icon="true"
        >
          <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.18" />
          <text
            x="8"
            y="11"
            textAnchor="middle"
            fill="currentColor"
            fontSize="8"
            fontWeight="700"
          >
            {provider.slice(0, 1).toUpperCase()}
          </text>
        </svg>
      );
  }
}
