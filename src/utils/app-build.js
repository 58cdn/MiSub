import packageJson from '../../package.json';

// Tests and source previews have no injected revision; never invent a source SHA.
export const APP_BUILD =
    typeof __MISUB_BUILD__ !== 'undefined'
        ? __MISUB_BUILD__
        : Object.freeze({
              component: 'app',
              productVersion: packageJson.version,
              displayVersion: packageJson.version,
              sourceCommit: null,
              channel: 'alpha',
              prerelease: true,
              dirty: null,
          });
