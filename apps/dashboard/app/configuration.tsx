'use client';

import { Check, ChevronDown, LoaderCircle } from 'lucide-react';
import * as Select from '@radix-ui/react-select';
import * as Popover from '@radix-ui/react-popover';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { PageHeader } from './components';
import type { GuildConfig } from './dashboard-types';

// Discord documente le sélecteur à 20 préréglages sans publier les hex.
// Référence vérifiée : Pylon SDK, enum RoleColors (20 valeurs, hors DEFAULT),
// https://pylon.bot/docs/reference/enums/discord.decor.rolecolors.html
export const roleColors = [
  '#1ABC9C', '#2ECC71', '#3498DB', '#9B59B6', '#E91E63', '#F1C40F', '#E67E22', '#E74C3C', '#95A5A6', '#607D8B',
  '#11806A', '#1F8B4C', '#206694', '#71368A', '#AD1457', '#C27C0E', '#A84300', '#992D22', '#979C9F', '#546E7A',
] as const;
const brandColor = '#7775F5';
const validHex = (value: string) => /^#[0-9A-F]{6}$/i.test(value);
function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => { const k = (n + h / 60) % 6; return Math.round((v - v * s * Math.max(Math.min(k, 4 - k, 1), 0)) * 255).toString(16).padStart(2, '0'); };
  return `#${f(5)}${f(3)}${f(1)}`.toUpperCase();
}
function hexToHsv(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0;
  if (delta) { if (max === r) h = ((g - b) / delta) % 6; else if (max === g) h = (b - r) / delta + 2; else h = (r - g) / delta + 4; h = (h * 60 + 360) % 360; }
  return [h, max ? delta / max : 0, max];
}
function ColorPicker({ color, onChange }: { color: string; onChange: (value: string) => void }) {
  const [hexText, setHexText] = useState(color);
  useEffect(() => setHexText(color), [color]);
  const plane = useRef<HTMLDivElement>(null);
  const [computedHue, s, v] = useMemo(() => hexToHsv(validHex(color) ? color : brandColor), [color]);
  const [h, setHue] = useState(computedHue);
  useEffect(() => { if (s > 0) setHue(computedHue); }, [computedHue, s]);
  const setFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = plane.current?.getBoundingClientRect(); if (!rect) return;
    const nextS = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const nextV = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    onChange(hsvToHex(h, nextS, nextV));
  };
  const keyPlane = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? .1 : .01;
    const nextS = event.key === 'ArrowRight' ? Math.min(1, s + step) : event.key === 'ArrowLeft' ? Math.max(0, s - step) : s;
    const nextV = event.key === 'ArrowUp' ? Math.min(1, v + step) : event.key === 'ArrowDown' ? Math.max(0, v - step) : v;
    if (nextS !== s || nextV !== v) { event.preventDefault(); onChange(hsvToHex(h, nextS, nextV)); }
  };
  return <Popover.Root><Popover.Trigger className="color-trigger" type="button" aria-label="Choisir la couleur des embeds"><span className="color-trigger-swatch" style={{ background: validHex(color) ? color : brandColor }} /><span>{color}</span><ChevronDown size={15} /></Popover.Trigger><Popover.Portal><Popover.Content className="color-popover" side="bottom" align="start" sideOffset={6} collisionPadding={12}>
    <strong>Couleur des embeds</strong><div className="color-presets"><button type="button" className={`color-preset${color.toUpperCase() === brandColor ? ' is-selected' : ''}`} style={{ background: brandColor }} title={`Veyro ${brandColor}`} aria-label={`Veyro ${brandColor}`} aria-pressed={color.toUpperCase() === brandColor} onClick={() => onChange(brandColor)}>{color.toUpperCase() === brandColor && <Check size={15} />}</button>{roleColors.map(value => <button key={value} type="button" className={`color-preset${color.toUpperCase() === value ? ' is-selected' : ''}`} style={{ background: value }} title={value} aria-label={`Couleur ${value}`} aria-pressed={color.toUpperCase() === value} onClick={() => onChange(value)}>{color.toUpperCase() === value && <Check size={15} />}</button>)}</div>
    <div ref={plane} role="slider" tabIndex={0} aria-label="Saturation et luminosité" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s * 100)} aria-valuetext={`Saturation ${Math.round(s * 100)} %, luminosité ${Math.round(v * 100)} %`} className="color-plane" style={{ backgroundColor: `hsl(${h} 100% 50%)` }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setFromPointer(event); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setFromPointer(event); }} onKeyDown={keyPlane}><span className="color-plane-cursor" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }} /></div>
    <label className="field color-hue"><span>Teinte</span><input type="range" min="0" max="359" value={Math.round(h)} onChange={event => { const next = Number(event.target.value); setHue(next); onChange(hsvToHex(next, s, v)); }} aria-label="Teinte" /></label>
    <label className="field"><span>Code hexadécimal</span><input className="text-input" value={hexText} maxLength={7} pattern="#[0-9a-fA-F]{6}" onChange={event => { const next = event.target.value.toUpperCase(); setHexText(next); onChange(next); }} aria-invalid={!validHex(hexText)} /></label><Popover.Arrow className="popover-arrow" /></Popover.Content></Popover.Portal></Popover.Root>;
}

const timeZones = ['UTC', ...Intl.supportedValuesOf('timeZone')];
const languages = [{ value: 'fr', label: 'Français', flag: '/flags/fr.svg' }, { value: 'en', label: 'English', flag: '/flags/gb.svg' }] as const;
function SelectTrigger({ label, children }: { label: string; children: ReactNode }) {
  return <Select.Trigger className="custom-select" aria-label={label}><span className="custom-select-value">{children}</span><Select.Icon className="custom-select-icon"><ChevronDown size={16} /></Select.Icon></Select.Trigger>;
}
function LanguageFlag({ src }: { src: string }) {
  return <img className="language-flag" src={src} alt="" aria-hidden="true" width={20} height={15} />;
}
function TimeZoneSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const options = timeZones.includes(value) ? timeZones : [value, ...timeZones];
  return <Select.Root value={value} onValueChange={onChange}><SelectTrigger label="Fuseau horaire IANA"><Select.Value /></SelectTrigger><Select.Portal><Select.Content className="select-content" position="popper" sideOffset={5} align="start" collisionPadding={10}><Select.Viewport className="select-viewport">{options.map(zone => <Select.Item key={zone} value={zone} className="select-item"><Select.ItemText>{zone}</Select.ItemText><Select.ItemIndicator><Check size={15} /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root>;
}

export function SettingsPage({ config, loading, onChange }: { config: GuildConfig | null; loading: boolean; onChange: <K extends 'language' | 'timeZone' | 'embedColor'>(key: K, value: GuildConfig[K]) => void }) {
  if (loading || !config) return <><PageHeader title="Paramètres" description="Ici, tu peux ajuster VeyroBot pour ton serveur." /><div className="loading-row"><LoaderCircle className="spin" size={16} /> Chargement des paramètres…</div></>;
  const previewColor = validHex(config.embedColor) ? config.embedColor : brandColor;
  let displayDate = '';
  try { displayDate = new Intl.DateTimeFormat(config.language === 'fr' ? 'fr-FR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: config.timeZone }).format(new Date()); } catch { displayDate = 'Fuseau horaire invalide'; }
  return <><PageHeader title="Paramètres" description="Ici, tu peux ajuster VeyroBot pour ton serveur." /><section className="surface section-panel settings-panel"><h2>Préférences du serveur</h2><div className="settings-fields"><div className="field"><span>Langue du serveur</span><Select.Root value={config.language} onValueChange={value => onChange('language', value as 'fr' | 'en')}><SelectTrigger label="Langue du serveur"><LanguageFlag src={config.language === 'fr' ? '/flags/fr.svg' : '/flags/gb.svg'} /><Select.Value /></SelectTrigger><Select.Portal><Select.Content className="select-content" position="popper" sideOffset={5} collisionPadding={10}><Select.Viewport>{languages.map(item => <Select.Item key={item.value} value={item.value} className="select-item"><LanguageFlag src={item.flag} /><Select.ItemText>{item.label}</Select.ItemText><Select.ItemIndicator><Check size={15} /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root><small>Langue des réponses du bot. Le drapeau est une illustration de la langue.</small></div>
    <div className="field"><span>Fuseau horaire IANA</span><TimeZoneSelect value={config.timeZone} onChange={value => onChange('timeZone', value)} /><small>Les dates restent stockées en UTC.</small></div>
    <div className="field"><span>Couleur des embeds par défaut</span><ColorPicker color={config.embedColor} onChange={value => onChange('embedColor', value)} /><small>Choisissez une couleur ou saisissez son code #RRGGBB.</small><div className="embed-preview" style={{ borderLeftColor: previewColor }}><strong>{config.language === 'fr' ? 'Action de modération' : 'Moderation action'}</strong><p>{config.language === 'fr' ? 'Un résultat apparaîtra ici.' : 'A result will appear here.'}</p><small>{displayDate}</small></div><small>Aperçu local : aucun message n’est envoyé à Discord.</small></div></div></section></>;
}
