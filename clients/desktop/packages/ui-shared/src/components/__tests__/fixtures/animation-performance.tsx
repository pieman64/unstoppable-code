import { useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatComposerShell } from '../../ChatComposerShell';
import { useAnimatedComposerBox } from '../../ComposerLayout';
import { ThinkingSpinner } from '../../ThinkingSpinner';
import { FoldReveal } from '../../FoldReveal';
import { StepRow } from '../../chat/StepRow';

function Fixture(): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useAnimatedComposerBox(ref);
  return (
    <main className="p-6 bg-base fg-primary" data-testid="motion-fixture">
      <button
        data-testid="toggle-motion"
        onClick={() => setExpanded(!expanded)}
      >
        Toggle layout
      </button>
      <div className="grid grid-cols-10 gap-2 py-4" data-testid="spinner-stage">
        {Array.from({ length: 100 }, (_, i) => (
          <span key={i}>
            <ThinkingSpinner /> Running {i + 1}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-2 py-4" data-testid="shimmer-stage">
        {Array.from({ length: 100 }, (_, i) => (
          <StepRow key={i} running label={`Running step ${i + 1}`} />
        ))}
      </div>
      <ChatComposerShell
        shellRef={ref}
        layout={expanded ? 'full' : 'one-line'}
        dataTestId="motion-composer"
      >
        <textarea
          aria-label="Draft"
          className="w-full bg-transparent"
          style={{ height: expanded ? 100 : 24 }}
          defaultValue="Preserve this draft"
        />
      </ChatComposerShell>
      <FoldReveal open={expanded}>
        <span>More controls</span>
      </FoldReveal>
      <aside
        data-testid="motion-sidebar"
        className="sidebar-layout-transition transition-[width] duration-200"
        style={{ width: expanded ? 220 : 360 }}
      >
        Sidebar
      </aside>
    </main>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
