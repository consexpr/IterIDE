import appIcon from '../../shared/branding/iter-icon.svg'
// Small stroke icon set (24px grid, 1.6 stroke) so the UI has no icon-font dependency.
const paths: Record<string, string> = {
    play: 'M7 5.5v13l11-6.5z',
    bug: 'M9 7.5V6a3 3 0 0 1 6 0v1.5M8 9h8a1 1 0 0 1 1 1v3a5 5 0 0 1-10 0v-3a1 1 0 0 1 1-1zM12 9v9M4 12h3M17 12h3M5 7l2.5 2M19 7l-2.5 2M5 18l2.5-2M19 18l-2.5-2',
    stop: 'M7 7h10v10H7z',
    send: 'M4.5 12 19.5 5l-4 14-3.5-5.5zM12 13.5 19.5 5',
    plus: 'M12 5v14M5 12h14',
    folder: 'M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
    file: 'M7 3.5h6.5L18 8v12.5H7zM13.5 3.5V8H18',
    settings:
        'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM19.4 13.5l1.4 1.1-1.8 3.1-1.7-.6a7 7 0 0 1-1.9 1.1l-.3 1.8h-3.6l-.3-1.8a7 7 0 0 1-1.9-1.1l-1.7.6-1.8-3.1 1.4-1.1a7 7 0 0 1 0-2.2L3.8 10.3l1.8-3.1 1.7.6a7 7 0 0 1 1.9-1.1l.3-1.8h3.6l.3 1.8a7 7 0 0 1 1.9 1.1l1.7-.6 1.8 3.1-1.4 1.1a7 7 0 0 1 0 2.2z',
    x: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    chevron: 'M9 6l6 6-6 6',
    chevronDown: 'M6 9l6 6 6-6',
    stepOver: 'M5 13a7 7 0 0 1 13.2-3M18.5 5v5h-5M12 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    stepIn: 'M12 3.5v10M7.5 9.5l4.5 4.5 4.5-4.5M12 20.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    stepOut: 'M12 14V4M7.5 8.5 12 4l4.5 4.5M12 20.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    stepBack: 'M19 13a7 7 0 0 0-13.2-3M5.5 5v5h5M12 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    continue: 'M6 5.5v13M10 5.5v13l9-6.5z',
    restart: 'M5 12a7 7 0 1 0 2.1-5M5 4.5V9h4.5',
    trash: 'M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    more: 'M6 12h.01M12 12h.01M18 12h.01',
    download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14',
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    terminal: 'M5 7l4 4-4 4M11 16h7',
    eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
    palette:
        'M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.9 1.4-1.9-.4-1 .2-2.1 1.3-2.1h2.1a3.7 3.7 0 0 0 3.7-3.7C20.5 7.3 16.7 3.5 12 3.5zM7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    file_io: 'M4 7h7M8 4l3 3-3 3M20 17h-7M16 14l-3 3 3 3',
    panelClose: 'M4 5.5h16v13H4zM14.5 5.5v13M17 10l-1.5 2 1.5 2',
    panelOpen: 'M4 5.5h16v13H4zM14.5 5.5v13M16 10l1.5 2-1.5 2',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
    toCursor: 'M5 6.5v11M9 12h9M14.5 8.5 18 12l-3.5 3.5M5 12h.01',
    cloud: 'M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 9.6 4.5 4.5 0 0 0 7 18.5z',
    github: 'M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21'
}

export type IconName = keyof typeof paths

export function Icon({ name, size = 16, fill = false }: { name: IconName; size?: number; fill?: boolean }) {
    return (
        <svg
            className="nv-icon"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill={fill ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
        >
            <path d={paths[name]} />
        </svg>
    )
}

export function Logo({ size = 18, expanded = false }: { size?: number; expanded?: boolean }) {
    return (
        <img
            src={appIcon}
            width={size}
            height={size}
            alt=""
            aria-hidden
            draggable={false}
            className="nv-logo"
            data-expanded={expanded}
        />
    )
}
