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

// Applies the saved theme before the first paint, so a light-theme visitor never sees a dark flash.
// It also marks a visit with ?intro, so the page starts hidden behind the opening titles (Intro.tsx).
const applySavedTheme = `try{document.documentElement.dataset.theme=localStorage.getItem('hyperspace-theme')==='light'?'light':'dark'}catch(e){document.documentElement.dataset.theme='dark'}try{var i=new URLSearchParams(location.search).get('intro');if(i!==null)document.documentElement.dataset.intro=i}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable} data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: applySavedTheme }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
