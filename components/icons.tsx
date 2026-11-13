type P = { size?: number };
const base = (size = 18) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true });

export const LeafMark = ({ size = 20, color = "#f4efe6" }: P & { color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14Z" fill={color} />
    <path d="M5 19 14 10" stroke="#1f4434" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const BoxIcon = ({ size }: P) => (<svg {...base(size)}><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" /><path d="M3 7.5 12 12l9-4.5M12 12v9" /></svg>);
export const TruckIcon = ({ size }: P) => (<svg {...base(size)}><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" /><circle cx="7" cy="17.5" r="1.8" /><circle cx="17" cy="17.5" r="1.8" /></svg>);
export const ListIcon = ({ size }: P) => (<svg {...base(size)}><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>);
export const SendIcon = ({ size }: P) => (<svg {...base(size)}><path d="M5 12h13M12 5l7 7-7 7" /></svg>);
export const CloseIcon = ({ size }: P) => (<svg {...base(size)}><path d="M6 6l12 12M18 6 6 18" /></svg>);
export const PlusIcon = ({ size }: P) => (<svg {...base(size)}><path d="M12 5v14M5 12h14" /></svg>);
export const SearchIcon = ({ size }: P) => (<svg {...base(size)}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4-4" /></svg>);
