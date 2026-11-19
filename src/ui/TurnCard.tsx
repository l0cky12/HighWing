// A card for a turn the owner didn't type in this chat, folded open: a Returned result (ADR 0175), a teammate's
// message or a message this bot sent one (ADR 0207), and an Asked card (ADR 0232).
import { type HTMLAttributes, type ReactNode, useState } from "react";
import { ChevronRight } from "lucide-react";

export function TurnCard({
  kind = "",
  icon,
  heading,
  tips,
  foot,
  children,
  ...rest
}: { kind?: string; icon: ReactNode; heading: ReactNode; tips: { hide: string; show: string }; foot?: ReactNode; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`msg returned ${kind}`.trimEnd()} {...rest}>
      <button className="returned-head" aria-expanded={open} title={open ? tips.hide : tips.show} onClick={() => setOpen((o) => !o)}>
        {icon}
        <span className="returned-title">{heading}</span>
        <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} aria-hidden />
      </button>
      {open && children}
      {foot}
    </div>
  );
}
