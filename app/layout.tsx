import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { inter } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hyperspace',
  description: 'Explore thousands of connected AI concepts on a hyperbolic disk. Search by meaning and bend space to what you care about.',
};

export const viewport: Viewport = {
  themeColor: '#04060d',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
