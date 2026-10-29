import type { BrowserService } from './browser-service';

let browserService: BrowserService | null = null;

export function setBrowserService(service: BrowserService | null): void {
  browserService = service;
}

export function getBrowserService(): BrowserService | null {
  return browserService;
}
