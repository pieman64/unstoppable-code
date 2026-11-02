import './styles/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { brand } from '@/lib/brand';
import { applyBrandDocumentHead } from '@/lib/brandDocumentHead';
import { applyTheme, installBrandDefaultTheme } from '@/lib/theme';
import { CoordinatorLabPage } from '@/components/dev/CoordinatorLabPage';
import { savedCoordinatorMode } from '@/components/dev/coordinatorLabMode';

applyBrandDocumentHead(brand);
installBrandDefaultTheme();
applyTheme('default', savedCoordinatorMode());
document.title = 'Chats';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <CoordinatorLabPage />
    </StrictMode>,
  );
}
