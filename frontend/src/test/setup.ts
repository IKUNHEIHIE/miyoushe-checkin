import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 5000 });
import { beforeEach, afterEach, vi } from 'vitest';
import { mockFetch, setCaptchaRejection, testCaptchaResult } from './mockHttp';
import { testNow } from './mockClock';
import { setCsrfTokenInMemory } from '../api/client';

function createMemoryStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      store = {};
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
    removeItem(key: string) {
      delete store[key];
    },
    setItem(key: string, value: string) {
      store[key] = String(value);
    }
  };
}

if (typeof window !== 'undefined') {
  if (!window.localStorage || typeof window.localStorage.getItem !== 'function') {
    Object.defineProperty(window, 'localStorage', {
      value: createMemoryStorage(),
      writable: true,
      configurable: true
    });
  }
  if (!window.sessionStorage || typeof window.sessionStorage.getItem !== 'function') {
    Object.defineProperty(window, 'sessionStorage', {
      value: createMemoryStorage(),
      writable: true,
      configurable: true
    });
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(mockFetch));
  vi.spyOn(Date, 'now').mockImplementation(testNow);
  setCsrfTokenInMemory(null); setCaptchaRejection(false);
  const script = document.createElement('script');
  script.src = 'https://static.geetest.com/v4/gt4.js'; script.dataset.testSdk = 'true'; document.head.appendChild(script);
  window.initGeetest4 = (_config, callback) => {
    let success = () => {};
    const sdk = {
      onReady(fn: () => void) { fn(); return sdk; }, onSuccess(fn: () => void) { success = fn; return sdk; },
      onClose() { return sdk; }, onError() { return sdk; }, showCaptcha() { success(); }, getValidate: testCaptchaResult, destroy() {}
    };
    callback(sdk);
  };
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.initGeetest4;
  document.querySelectorAll('script[data-test-sdk]').forEach(script => script.remove());
});
