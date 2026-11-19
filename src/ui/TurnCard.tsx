// The card a turn the owner didn't type shows as: a Returned result, a bot's message to a teammate, an Ask. It is open
// from the start, and its heading folds it.
import { useState, type HTMLAttributes, type ReactNode } from "react";
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
