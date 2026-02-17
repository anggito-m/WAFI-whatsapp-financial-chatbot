export default function HomePage() {
  return (
    <main
      style={{
        maxWidth: 760,
        margin: "3rem auto",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        lineHeight: 1.6,
        padding: "0 1rem"
      }}
    >
      <h1>Finance Bot Webhooks</h1>
      <p>Telegram endpoint: <code>/api/telegram</code></p>
      <p>WhatsApp endpoint: <code>/api/whatsapp</code></p>
    </main>
  );
}
