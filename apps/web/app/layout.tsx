import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../src/styles/app.css';

export const metadata: Metadata = {
  title: 'Agentic World — observation console',
  description: 'Live telemetry for a simulated world, assembled entirely from its world definition.',
};

export const viewport: Viewport = {
  themeColor: '#070A0E',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Spline+Sans+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
