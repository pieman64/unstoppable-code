import { Buffer } from 'node:buffer';

const ENTRY_PATH = '/browser-lab/auth';
const PROTECTED_PATH = '/browser-lab/auth/protected';
const USERNAME = 'browser-lab-user';
const PASSWORD = 'browser-lab-pass-7Q4M';
const REALM = 'Browser Lab auth';
const CHALLENGE = 'Basic realm="Browser Lab auth", charset="UTF-8"';

export const interactionCase = {
  id: 'auth',
  kind: 'interaction',
  title: 'Basic authentication',
  entryPath: ENTRY_PATH,
  pages: [
    {
      path: ENTRY_PATH,
      controls: ['browser-lab-auth-main', 'browser-lab-auth-protected-link'],
    },
    {
      path: PROTECTED_PATH,
      controls: ['browser-lab-auth-protected-main', 'browser-lab-auth-welcome'],
      requiresAuth: true,
      deniedControls: ['browser-lab-auth-denied-main'],
    },
  ],
  credentials: { username: USERNAME, password: PASSWORD, realm: REALM },
};

function validCredentials(header) {
  if (typeof header !== 'string' || header.length > 512) return false;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return false;
  const encoded = match[1];
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return false;
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  const username = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);
  return username === USERNAME && password === PASSWORD;
}

export function createRoutes(kit) {
  const { html } = kit;
  const intro = kit.pageRoute(() =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      main: html`<main data-testid="browser-lab-auth-main">
        <h1>${interactionCase.title}</h1>
        <p>This page links to a protected Browser Lab resource.</p>
        <a
          href="${PROTECTED_PATH}"
          data-testid="browser-lab-auth-protected-link"
          >Open protected page</a
        >
      </main>`,
    }),
  );
  const protectedRoute = {
    kind: 'html',
    methods: {
      GET: (context) => {
        if (!validCredentials(context.request.headers.authorization)) {
          const denied = kit.renderInteractionPage({
            caseDef: interactionCase,
            suffix: 'Authentication required',
            main: html`<main data-testid="browser-lab-auth-denied-main">
              <h1>Authentication required</h1>
              <p>Provide valid HTTP Basic credentials to continue.</p>
            </main>`,
          });
          return kit.sendPage(context.response, 401, denied, {
            'www-authenticate': CHALLENGE,
          });
        }
        return kit.sendPage(
          context.response,
          200,
          kit.renderInteractionPage({
            caseDef: interactionCase,
            main: html`<main data-testid="browser-lab-auth-protected-main">
              <h1>Protected page</h1>
              <p data-testid="browser-lab-auth-welcome">
                Welcome, ${USERNAME}.
              </p>
            </main>`,
          }),
        );
      },
    },
  };
  return [
    [ENTRY_PATH, intro],
    [PROTECTED_PATH, protectedRoute],
  ];
}
