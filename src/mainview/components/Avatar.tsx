export function Avatar({
  author,
  agent = false,
}: {
  author: string;
  agent?: boolean;
}) {
  const initial = author.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={agent ? "room-avatar is-agent" : "room-avatar"}
      aria-label={agent ? `${author}, agent` : author}
    >
      {agent ? (
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <path
            d="M 80 28 L 14 28 L 50 58 L 14 88 L 80 88"
            fill="none"
            stroke="currentColor"
            strokeWidth="15"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : initial}
    </span>
  );
}
