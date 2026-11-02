import { type JSX, useEffect, useRef, useState } from 'react';
import {
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuSurface,
} from './DropdownMenu';
import { ActionMenuRowStyle } from './ActionMenuItems';
import { Button } from './Button';
import { isMenuOpenBodyFlagSet } from '../lib/menu-open-body-flag';
import {
  AgentIcon,
  BundleIcon,
  ChevronDownMediumIcon,
  GitHubIcon,
  McpServerIcon,
  SquarePlusIcon,
  StorefrontIcon,
} from '../icons/AppIcons';

/**
 * Custom-add actions supported by a Customize host, always behind one "Add
 * custom" menu so every host reads the same. The host owns each dialog and
 * supplies callbacks for available actions.
 */
export interface PluginsAddCustomMenuProps {
  onAddMarketplace?: () => void;
  onAddMcpServer?: () => void;
  onInstallSkillsFromGitHub?: () => void;
  onCreateCustomSkill?: () => void;
  /**
   * Opens the collection editor in create mode. Collections used to be
   * creatable only from Installed > Collections, which left the Marketplace's
   * own Collections tab with no way forward; hosts without a collection
   * editor omit this and the item is not rendered.
   */
  onCreateCollection?: () => void;
  /**
   * Opens the host's agent editor in create mode. Only hosts that manage local
   * agents supply it; the item is not rendered otherwise.
   */
  onCreateAgent?: () => void;
}

export function PluginsAddCustomMenu({
  onAddMarketplace,
  onAddMcpServer,
  onInstallSkillsFromGitHub,
  onCreateCustomSkill,
  onCreateCollection,
  onCreateAgent,
}: PluginsAddCustomMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside POINTER-DOWN with a containment check, matching the
  // discovery card menus. Closing on a document *click* while the trigger
  // stops propagation means opening another menu never closes this one, so
  // two menus float at once.
  //
  // `pointerdown` rather than `mousedown` so this fires in the same phase the
  // shared FloatingMenu dismisses on, keeping the ordering between the two
  // menu implementations on this page identical.
  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(event: Event): void {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return (): void =>
      document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const runAndClose = (action: () => void): void => {
    setOpen(false);
    action();
  };

  if (
    ![
      onAddMarketplace,
      onAddMcpServer,
      onInstallSkillsFromGitHub,
      onCreateCustomSkill,
      onCreateCollection,
      onCreateAgent,
    ].some(Boolean)
  )
    return null;

  // One "Add custom" menu on every host (CAN-4261), even when custom MCP
  // servers are its only item, so desktop and web read the same.
  return (
    // The desktop Plugins page seats this in the title bar's drag region;
    // the class is inert on the web.
    <div className="electron-no-drag relative inline-block" ref={containerRef}>
      <Button
        variant="primary"
        size="compact"
        data-testid="plugins-add-custom-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={() => {
          // A card menu open on this page dismisses on pointerdown and
          // swallows the click that press completes, so opening on click alone
          // would cost the user a second press to reach these items.
          if (!open && isMenuOpenBodyFlagSet(document)) {
            setOpen(true);
          }
        }}
        onClick={() => setOpen((value) => !value)}
      >
        <span>Add custom</span>
        {/* The chevron sits 2px past the label, inside the button's gap. */}
        <ChevronDownMediumIcon size={16} aria-hidden="true" className="-ml-1" />
      </Button>
      {open && (
        <DropdownMenuSurface className="absolute right-0 z-30 mt-3 w-56">
          <ActionMenuRowStyle>
            {onAddMcpServer && (
              <DropdownMenuItem
                data-testid="plugins-add-custom-mcp"
                onClick={() => runAndClose(onAddMcpServer)}
              >
                <DropdownMenuItemIcon data-testid="plugins-add-custom-mcp-icon">
                  <McpServerIcon />
                </DropdownMenuItemIcon>
                Add custom MCP server…
              </DropdownMenuItem>
            )}
            {onAddMarketplace && (
              <DropdownMenuItem
                data-testid="plugins-add-custom-marketplace"
                onClick={() => runAndClose(onAddMarketplace)}
              >
                <DropdownMenuItemIcon data-testid="plugins-add-custom-marketplace-icon">
                  <StorefrontIcon />
                </DropdownMenuItemIcon>
                Add marketplace…
              </DropdownMenuItem>
            )}
            {onInstallSkillsFromGitHub && (
              <DropdownMenuItem
                data-testid="plugins-add-custom-skills-github"
                onClick={() => runAndClose(onInstallSkillsFromGitHub)}
              >
                <DropdownMenuItemIcon data-testid="plugins-add-custom-skills-github-icon">
                  <GitHubIcon />
                </DropdownMenuItemIcon>
                Install skills from GitHub…
              </DropdownMenuItem>
            )}
            {onCreateCustomSkill && (
              <DropdownMenuItem
                data-testid="plugins-add-custom-skill-custom"
                onClick={() => runAndClose(onCreateCustomSkill)}
              >
                <DropdownMenuItemIcon data-testid="plugins-add-custom-skill-custom-icon">
                  <SquarePlusIcon />
                </DropdownMenuItemIcon>
                Create custom skill…
              </DropdownMenuItem>
            )}
            {onCreateCollection && (
              <DropdownMenuItem
                data-testid="plugins-add-custom-collection"
                onClick={() => runAndClose(onCreateCollection)}
              >
                <DropdownMenuItemIcon data-testid="plugins-add-custom-collection-icon">
                  <BundleIcon />
                </DropdownMenuItemIcon>
                Add collection…
              </DropdownMenuItem>
            )}
            {onCreateAgent && (
              <DropdownMenuItem
                data-testid="plugins-add-custom-agent"
                onClick={() => runAndClose(onCreateAgent)}
              >
                <DropdownMenuItemIcon data-testid="plugins-add-custom-agent-icon">
                  <AgentIcon />
                </DropdownMenuItemIcon>
                New agent…
              </DropdownMenuItem>
            )}
          </ActionMenuRowStyle>
        </DropdownMenuSurface>
      )}
    </div>
  );
}
