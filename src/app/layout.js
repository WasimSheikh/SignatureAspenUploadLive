import "./globals.css";

export const metadata = {
  title: "Signature Aspen | Design File Delivery",
  description: "Share large design assets securely, without an account.",
  robots: { index: false, follow: false },
  icons: {
    icon: [{ url: "/favicon.ico" }, { url: "/icon.png", type: "image/png" }],
    apple: "/apple-icon.png",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
