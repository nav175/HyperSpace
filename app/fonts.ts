import { Inter } from 'next/font/google';

// Apple devices use SF Pro; everyone else gets Inter, self-hosted at build time so it works offline.
export const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const canvasFont = `-apple-system, BlinkMacSystemFont, "SF Pro Text", ${inter.style.fontFamily}, "Segoe UI", system-ui, sans-serif`;
