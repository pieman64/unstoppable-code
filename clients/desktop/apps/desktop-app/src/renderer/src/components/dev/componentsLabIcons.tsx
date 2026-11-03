import type { JSX } from 'react';
import {
  BranchIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  FolderIcon,
  ICON_SIZE_PX,
  SearchIcon,
  SettingsIcon,
  type IconSize,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const USES: Readonly<Record<IconSize, string>> = {
  xs: 'Badge glyphs, small chevrons',
  sm: 'Default: buttons, menus, rows, text',
  md: 'A compact control’s true 16px glyph',
  lg: 'Larger controls',
  xl: 'Toolbar and navigation',
  '2xl': 'Large standalone icons',
};

const SIZES: readonly IconSize[] = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];

export function IconScaleSpecimen(): JSX.Element {
  return (
    <SpecimenPanel>
      <SpecimenGrid min={180}>
        {SIZES.map((size) => (
          <SpecimenCell
            key={size}
            label={`${size}, ${ICON_SIZE_PX[size]}px: ${USES[size]}`}
          >
            <ChatIcon size={size} />
            <FolderIcon size={size} />
            <SearchIcon size={size} />
            <SettingsIcon size={size} />
            <BranchIcon size={size} />
            <CheckIcon size={size} />
            <CloseIcon size={size} />
          </SpecimenCell>
        ))}
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
