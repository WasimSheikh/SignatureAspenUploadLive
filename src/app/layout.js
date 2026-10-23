import "./globals.css";

export const metadata = {
  title: "Design Delivery",
  description: "Share large design assets securely, without an account.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
