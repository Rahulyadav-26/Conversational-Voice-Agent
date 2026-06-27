import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ConvoAgent — AI Voice Assistant",
  description: "Conversational Voice Agent with live monitoring, appointment booking, and warm transfer via Twilio.",
  keywords: ["voice agent", "AI assistant", "appointment booking", "LiveKit"],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
