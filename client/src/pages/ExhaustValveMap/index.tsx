import { useAccess } from '@/access/AccessProvider';
import { canPerformBusinessAction, isProfessionalBusinessPrincipal } from '@shared/business-permissions';
import React, { useEffect, useState } from 'react';

import { getGlobalNavigationViewportHeight } from '@/navigation/global-navigation-layout';

const DESIGN_WIDTH = 1672;
const DESIGN_HEIGHT = 941;
const HEADER_HEIGHT = 108;

const C = {
  blueDark: '#062A82',
  blueMain: '#0B5FFF',
  blueLine: '#126BFF',
  blueLight: '#EAF4FF',
  green: '#00A652',
  greenLight: '#F0FFF5',
  purpleLight: '#F6F0FF',
  red: '#FF1414',
  textDark: '#07143A',
  textBlue: '#052A7A',
  borderLight: '#B7D4FF',
  device: '#202020',
};

const VALVE_CALLOUTS = {
  left: {
    textX: 420,
    textY: 630,
    lineStartX: 500,
    lineStartY: 610,
    lineEndX: 535,
    lineEndY: 497,
  },
  right: {
    textX: 908,
    textY: 350,
  },
};

type Anchor = 'start' | 'middle' | 'end';
type DoorDirection =
  | 'right-down'
  | 'left-down'
  | 'down-right'
  | 'down-left'
  | 'up-left'
  | 'up-right';

interface TextProps {
  x: number;
  y: number;
  children: React.ReactNode;
  size?: number;
  weight?: number;
  fill?: string;
  anchor?: Anchor;
}

function useStageScale() {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const updateScale = () => {
      setScale(
        Math.min(
          window.innerWidth / DESIGN_WIDTH,
          getGlobalNavigationViewportHeight(window.innerHeight) / DESIGN_HEIGHT,
          1,
        ),
      );
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

  return scale;
}

function SvgText({
  x,
  y,
  children,
  size = 18,
  weight = 700,
  fill = C.textBlue,
  anchor = 'middle',
}: TextProps) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={size}
      fontWeight={weight}
      fill={fill}
    >
      {children}
    </text>
  );
}

function MultilineText({
  x,
  y,
  lines,
  size = 22,
  gap = 28,
  fill = C.textBlue,
  anchor = 'middle',
}: {
  x: number;
  y: number;
  lines: string[];
  size?: number;
  gap?: number;
  fill?: string;
  anchor?: Anchor;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={size}
      fontWeight={800}
      fill={fill}
    >
      {lines.map((line, index) => (
        <tspan key={`${line}-${index}`} x={x} dy={index === 0 ? 0 : gap}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

function Room({
  x,
  y,
  w,
  h,
  fill = '#FFFFFF',
  strokeWidth = 2,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  strokeWidth?: number;
}) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      fill={fill}
      stroke={C.blueMain}
      strokeWidth={strokeWidth}
    />
  );
}

function SectionLabel({
  x,
  y,
  w,
  text,
  fill = C.blueLine,
}: {
  x: number;
  y: number;
  w: number;
  text: string;
  fill?: string;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={32} rx={5} fill={fill} />
      <SvgText x={x + w / 2} y={y + 23} size={17} weight={700} fill="#FFFFFF">
        {text}
      </SvgText>
    </g>
  );
}

function LightningIcon({ x, y, size = 34 }: { x: number; y: number; size?: number }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={size}
        height={size}
        rx={5}
        fill="#FFFFFF"
        stroke={C.blueMain}
        strokeWidth={1.5}
      />
      <path
        d={`M ${x + size * 0.58} ${y + size * 0.12} L ${x + size * 0.31} ${y + size * 0.54} H ${x + size * 0.5} L ${x + size * 0.39} ${y + size * 0.88} L ${x + size * 0.72} ${y + size * 0.42} H ${x + size * 0.52} Z`}
        fill={C.blueMain}
      />
    </g>
  );
}

function SingleDoor({
  x,
  y,
  size = 46,
  direction,
}: {
  x: number;
  y: number;
  size?: number;
  direction: DoorDirection;
}) {
  if (direction === 'right-down') {
    return (
      <g stroke={C.blueMain} strokeWidth={2} fill="none">
        <line x1={x} y1={y} x2={x + size} y2={y} />
        <path d={`M ${x + size} ${y} A ${size} ${size} 0 0 1 ${x} ${y + size}`} />
      </g>
    );
  }
  if (direction === 'left-down') {
    return (
      <g stroke={C.blueMain} strokeWidth={2} fill="none">
        <line x1={x} y1={y} x2={x - size} y2={y} />
        <path d={`M ${x - size} ${y} A ${size} ${size} 0 0 0 ${x} ${y + size}`} />
      </g>
    );
  }
  if (direction === 'down-right') {
    return (
      <g stroke={C.blueMain} strokeWidth={2} fill="none">
        <line x1={x} y1={y} x2={x} y2={y + size} />
        <path d={`M ${x} ${y + size} A ${size} ${size} 0 0 0 ${x + size} ${y}`} />
      </g>
    );
  }
  if (direction === 'down-left') {
    return (
      <g stroke={C.blueMain} strokeWidth={2} fill="none">
        <line x1={x} y1={y} x2={x} y2={y + size} />
        <path d={`M ${x} ${y + size} A ${size} ${size} 0 0 1 ${x - size} ${y}`} />
      </g>
    );
  }
  if (direction === 'up-left') {
    return (
      <g stroke={C.blueMain} strokeWidth={2} fill="none">
        <line x1={x} y1={y} x2={x - size} y2={y} />
        <path d={`M ${x - size} ${y} A ${size} ${size} 0 0 1 ${x} ${y - size}`} />
      </g>
    );
  }
  return (
    <g stroke={C.blueMain} strokeWidth={2} fill="none">
      <line x1={x} y1={y} x2={x + size} y2={y} />
      <path d={`M ${x + size} ${y} A ${size} ${size} 0 0 0 ${x} ${y - size}`} />
    </g>
  );
}

function DoubleDoor() {
  return (
    <g stroke={C.blueMain} strokeWidth={2} fill="none">
      <line x1={799} y1={300} x2={835} y2={334} />
      <path d="M 799 300 A 36 36 0 0 1 835 334" />
      <line x1={871} y1={300} x2={835} y2={334} />
      <path d="M 871 300 A 36 36 0 0 0 835 334" />
    </g>
  );
}

function Star({ cx, cy, r = 15 }: { cx: number; cy: number; r?: number }) {
  const inner = r * 0.4;
  const points = Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 === 0 ? r : inner;
    const angle = (-90 + index * 36) * (Math.PI / 180);
    return `${cx + Math.cos(angle) * radius},${cy + Math.sin(angle) * radius}`;
  }).join(' ');
  return <polygon points={points} fill={C.red} />;
}

function HeaderBuildingIcon({ x, y }: { x: number; y: number }) {
  return (
    <g stroke="#FFFFFF" strokeWidth={2} fill="none" strokeLinejoin="round">
      <path d={`M ${x + 5} ${y + 34} V ${y + 14} L ${x + 22} ${y + 4} L ${x + 39} ${y + 14} V ${y + 34}`} />
      <path d={`M ${x + 15} ${y + 34} V ${y + 21} H ${x + 29} V ${y + 34}`} />
      <path d={`M ${x + 8} ${y + 34} H ${x + 42}`} />
      <path d={`M ${x + 22} ${y + 4} V ${y + 34}`} opacity={0.55} />
    </g>
  );
}

function HeaderZapIcon({ x, y }: { x: number; y: number }) {
  return <path d={`M ${x + 20} ${y + 5} L ${x + 8} ${y + 25} H ${x + 20} L ${x + 14} ${y + 40} L ${x + 34} ${y + 16} H ${x + 22} Z`} fill="#FFFFFF" />;
}

function HeaderUserIcon({ x, y }: { x: number; y: number }) {
  return (
    <g stroke="#FFFFFF" strokeWidth={2.3} fill="none">
      <circle cx={x + 22} cy={y + 14} r={8} />
      <path d={`M ${x + 8} ${y + 40} Q ${x + 22} ${y + 24} ${x + 36} ${y + 40}`} />
    </g>
  );
}

function HeaderPinIcon({ x, y }: { x: number; y: number }) {
  return (
    <g stroke="#FFFFFF" strokeWidth={2.3} fill="none">
      <path d={`M ${x + 22} ${y + 40} S ${x + 38} ${y + 24} ${x + 38} ${y + 14} A 16 16 0 1 0 ${x + 6} ${y + 14} C ${x + 6} ${y + 24} ${x + 22} ${y + 40} ${x + 22} ${y + 40} Z`} />
      <circle cx={x + 22} cy={y + 15} r={5} />
    </g>
  );
}

function HeaderCard({
  x,
  w,
  icon,
  title,
  subtitle,
}: {
  x: number;
  w: number;
  icon: 'building' | 'zap' | 'user' | 'pin';
  title: string;
  subtitle?: string;
}) {
  const iconBox = icon === 'zap' || icon === 'pin' ? 'circle' : 'rect';
  return (
    <g>
      <rect
        x={x}
        y={18}
        width={w}
        height={72}
        rx={10}
        fill="rgba(13, 92, 190, 0.65)"
        stroke="#6AB4FF"
        strokeWidth={1.5}
      />
      {iconBox === 'circle' ? (
        <circle cx={x + 28} cy={54} r={24} fill="#0E76E8" stroke="#88C9FF" />
      ) : (
        <rect x={x + 18} y={33} width={44} height={44} rx={8} fill={C.blueLine} />
      )}
      {icon === 'building' ? <HeaderBuildingIcon x={x + 18} y={33} /> : null}
      {icon === 'zap' ? <HeaderZapIcon x={x + 8} y={30} /> : null}
      {icon === 'user' ? <HeaderUserIcon x={x + 1118 - 1100} y={33} /> : null}
      {icon === 'pin' ? <HeaderPinIcon x={x + 1292 - 1285} y={30} /> : null}
      <SvgText x={x + (iconBox === 'circle' ? 65 : 76)} y={subtitle ? 48 : 60} size={18} weight={700} fill="#FFFFFF" anchor="start">
        {title}
      </SvgText>
      {subtitle ? (
        <SvgText x={x + (iconBox === 'circle' ? 65 : 76)} y={74} size={icon === 'building' ? 19 : 20} weight={800} fill="#FFFFFF" anchor="start">
          {subtitle}
        </SvgText>
      ) : null}
    </g>
  );
}

function Pump({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width={34} height={34} fill="#FFFFFF" stroke={C.device} strokeWidth={1.5} />
      <SvgText x={x + 17} y={y + 24} size={20} weight={800} fill="#111111">
        泵
      </SvgText>
    </g>
  );
}

function EquipmentGroup({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <Pump x={x} y={y} />
      <Pump x={x + 58} y={y} />
      <rect x={x + 36} y={y + 92} width={42} height={86} fill="#FFFFFF" stroke={C.device} strokeWidth={1.5} />
      <SvgText x={x + 57} y={y + 122} size={22} weight={800} fill="#111111">板</SvgText>
      <SvgText x={x + 57} y={y + 152} size={22} weight={800} fill="#111111">换</SvgText>
      <rect x={x + 34} y={y + 240} width={52} height={70} fill="#FFFFFF" stroke={C.device} strokeWidth={1.5} />
      <SvgText x={x + 60} y={y + 260} size={18} weight={800} fill="#111111">冷</SvgText>
      <SvgText x={x + 60} y={y + 281} size={18} weight={800} fill="#111111">机</SvgText>
      <g stroke="#111111" strokeWidth={1.1} fill="none">
        <rect x={x + 47} y={y + 291} width={26} height={10} rx={2} />
        <circle cx={x + 53} cy={y + 304} r={2.5} />
        <circle cx={x + 67} cy={y + 304} r={2.5} />
      </g>
      <path
        d={`M ${x + 17} ${y + 34} L ${x + 17} ${y + 132} L ${x + 36} ${y + 154} L ${x + 36} ${y + 240} L ${x + 50} ${y + 240}`}
        stroke={C.blueMain}
        strokeWidth={4}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={`M ${x + 63} ${y + 34} L ${x + 63} ${y + 132} L ${x + 78} ${y + 154} L ${x + 78} ${y + 205} L ${x + 58} ${y + 228} L ${x + 58} ${y + 240}`}
        stroke={C.red}
        strokeWidth={4}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={`M ${x + 90} ${y} L ${x + 90} ${y + 205} L ${x + 78} ${y + 222}`}
        stroke={C.red}
        strokeWidth={4}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d={`M ${x + 78} ${y + 132} L ${x + 82} ${y + 132}`} stroke={C.red} strokeWidth={4} fill="none" strokeLinecap="round" />
      <circle cx={x + 30} cy={y + 132} r={8} fill={C.green} />
      <circle cx={x + 82} cy={y + 132} r={8} fill={C.green} />
    </g>
  );
}

function SecondaryPump({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width={54} height={170} fill="#FFFFFF" stroke={C.device} strokeWidth={1.5} />
      <SvgText x={x + 27} y={y + 48} size={24} weight={800} fill="#111111">二</SvgText>
      <SvgText x={x + 27} y={y + 88} size={24} weight={800} fill="#111111">次</SvgText>
      <SvgText x={x + 27} y={y + 128} size={24} weight={800} fill="#111111">泵</SvgText>
    </g>
  );
}

function MaleIcon({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} stroke={C.blueMain} strokeWidth={1.6} fill="none">
      <circle cx={10} cy={8} r={4} />
      <path d="M10 13 v18 M4 18 h12 M7 31 l-4 7 M13 31 l4 7" />
    </g>
  );
}

function FemaleIcon({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} stroke={C.blueMain} strokeWidth={1.6} fill="none">
      <circle cx={10} cy={8} r={4} />
      <path d="M10 13 v17 M4 18 h12 M6 30 h8 M10 30 v8" />
    </g>
  );
}

function SafetyExitIcon({ x, y, size = 34 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={size} height={size} rx={4} fill={C.green} />
      <path
        d={`M ${size * 0.38} ${size * 0.48} h${size * 0.4} m-${size * 0.19} -${size * 0.17} l${size * 0.2} ${size * 0.17} l-${size * 0.2} ${size * 0.17} M ${size * 0.28} ${size * 0.75} h-${size * 0.14} v-${size * 0.55} h${size * 0.25}`}
        stroke="#FFFFFF"
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

function ComputerIcon({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} stroke={C.blueMain} strokeWidth={1.5} fill="none">
      <rect x={0} y={0} width={38} height={25} rx={3} />
      <path d="M19 25 v12 M9 37 h20 M-7 40 h52" opacity={0.45} />
    </g>
  );
}

function GearIcon({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} stroke={C.blueMain} strokeWidth={1.7} fill="none">
      <circle cx={0} cy={0} r={14} />
      <circle cx={0} cy={0} r={5} />
      <path d="M0 -22 v8 M0 14 v8 M-22 0 h8 M14 0 h8 M-15 -15 l6 6 M9 9 l6 6 M15 -15 l-6 6 M-9 9 l-6 6" />
    </g>
  );
}

function CleaningIcon({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} stroke={C.blueMain} strokeWidth={1.6} fill="none">
      <path d="M22 0 L2 44 H45 Z M35 15 L55 0 M45 6 q6 8 13 5 M13 44 l-8 10 M39 44 l8 10" />
    </g>
  );
}

function HeaderLayer() {
  return (
    <g id="layer-header">
      <defs>
        <linearGradient id="headerGradient" x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stopColor="#041A62" />
          <stop offset="50%" stopColor="#08369A" />
          <stop offset="100%" stopColor="#05236F" />
        </linearGradient>
        <marker id="valveArrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={C.green} />
        </marker>
      </defs>
      <rect x={0} y={0} width={1672} height={108} fill="url(#headerGradient)" />
      <line x1={0} y1={108} x2={1672} y2={108} stroke="#35A7FF" strokeWidth={2} opacity={0.6} />
      {[
        'M520 24 H650 L680 42 H720',
        'M530 58 H640 L665 78 H740',
        'M1050 18 H1210 L1240 40 H1305',
        'M1200 76 H1340 L1370 58 H1440',
        'M250 92 H410 L438 66 H520',
      ].map((d) => (
        <path key={d} d={d} stroke="#2F97FF" opacity={0.25} strokeWidth={1} fill="none" />
      ))}
      {[720, 740, 1305, 1440, 520].map((x, index) => (
        <circle key={`${x}-${index}`} cx={x} cy={index % 2 ? 78 : 42} r={3} fill="#4AC1FF" opacity={0.4} />
      ))}
      <SvgText x={42} y={50} size={42} weight={800} fill="#FFFFFF" anchor="start">
        A-127 冷冻站平面布置示意图
      </SvgText>
      <circle cx={70} cy={78} r={4} fill="#38B6FF" />
      <circle cx={420} cy={78} r={4} fill="#38B6FF" />
      <SvgText x={92} y={86} size={22} weight={500} fill="#D8E9FF" anchor="start">
        空间布局 / 设备分布 / 位置指引
      </SvgText>
      <HeaderCard x={730} w={180} icon="building" title="冷冻站主区域" subtitle="A-127" />
      <HeaderCard x={930} w={150} icon="zap" title="配电间" subtitle="4处" />
      <HeaderCard x={1100} w={160} icon="user" title="值班/大厅" />
      <HeaderCard x={1285} w={185} icon="pin" title="定位引导" subtitle="精准导航" />
      <path d="M1516 0 H1672 V108 H1530 Q1516 108 1516 92 Z" fill="#FFFFFF" />
      <SvgText x={1588} y={34} size={24} weight={800} fill="#082777">北</SvgText>
      <circle cx={1588} cy={70} r={30} fill="#FFFFFF" stroke={C.blueMain} strokeWidth={2} />
      <path d="M1588 43 L1605 76 H1594 V96 H1582 V76 H1571 Z" fill={C.blueMain} />
    </g>
  );
}

function RoomsLayer() {
  return (
    <g id="layer-rooms">
      <Room x={32} y={128} w={270} h={575} fill="#F8FBFF" strokeWidth={2.5} />
      <SectionLabel x={52} y={146} w={105} text="01 柴发室" />
      <SvgText x={148} y={330} size={24} weight={800}>A-177</SvgText>
      <SvgText x={148} y={364} size={24} weight={800}>柴发室</SvgText>
      <g stroke="#9EC8FF" strokeWidth={1.2} fill="none" opacity={0.6}>
        <rect x={80} y={184} width={55} height={90} rx={6} />
        <rect x={91} y={280} width={34} height={150} />
        <rect x={80} y={438} width={55} height={125} rx={6} />
        <path d="M76 196 h64 M78 207 h60 M83 216 h50 M104 274 v36 M104 430 v28" />
        <rect x={185} y={160} width={32} height={100} />
        <rect x={178} y={375} width={55} height={180} />
        <path d="M166 388 q-16 22 0 45 M166 446 q-16 22 0 45 M166 504 q-16 22 0 45" />
      </g>
      <Room x={32} y={704} w={226} h={96} />
      <SvgText x={145} y={758} size={18}>备用/储物间</SvgText>
      <Room x={258} y={704} w={62} h={96} />

      <path d="M360 128 H825 V222 H792 V258 H392 V222 H360 Z" fill="#FFFFFF" stroke={C.blueMain} strokeWidth={2.5} />
      <SectionLabel x={382} y={148} w={95} text="02 配电间" />
      <LightningIcon x={500} y={190} />
      <SvgText x={552} y={212} size={22} weight={800} anchor="start">A-144 配电间</SvgText>

      <path d="M865 128 H1305 V258 H1232 V222 H865 Z" fill="#FFFFFF" stroke={C.blueMain} strokeWidth={2.5} />
      <SectionLabel x={886} y={148} w={95} text="02 配电间" />
      <LightningIcon x={1028} y={190} />
      <SvgText x={1080} y={212} size={22} weight={800} anchor="start">A-120 配电间</SvgText>

      <Room x={1310} y={128} w={78} h={104} />
      <MaleIcon x={1337} y={150} />
      <SvgText x={1349} y={215} size={17}>男卫</SvgText>
      <Room x={1388} y={128} w={78} h={104} />
      <FemaleIcon x={1415} y={150} />
      <SvgText x={1427} y={215} size={17}>女卫</SvgText>
      <Room x={1466} y={128} w={160} h={104} />

      <Room x={1435} y={264} w={190} h={280} fill={C.greenLight} strokeWidth={2.5} />
      <SafetyExitIcon x={1496} y={278} />
      <SvgText x={1513} y={330} size={17} fill={C.green}>安全出口</SvgText>
      <SvgText x={1530} y={395} size={26} weight={800}>大厅</SvgText>
      <g stroke={C.green} strokeWidth={1.5} fill="none">
        <rect x={1490} y={455} width={78} height={28} rx={4} />
        <path d="M1562 450 C1565 440 1570 440 1572 448 M1498 464 v12 M1505 464 h4" />
      </g>

      <Room x={1435} y={545} w={190} h={255} fill={C.purpleLight} strokeWidth={2.5} />
      <SvgText x={1530} y={610} size={24} weight={800}>A-112</SvgText>
      <SvgText x={1530} y={642} size={24} weight={800}>值班室</SvgText>
      <g stroke="#8C6BE8" fill="none" strokeWidth={1.5} opacity={0.9}>
        <rect x={1492} y={720} width={78} height={32} />
        <circle cx={1545} cy={695} r={12} />
        <path d="M1540 710 q-20 8 -23 32 M1552 710 q18 9 26 32 M1564 724 q-14 18 -36 19 M1492 720 h86" />
      </g>

      <rect x={320} y={300} width={1060} height={425} fill="#FFFFFF" stroke={C.blueMain} strokeWidth={3} />
      <rect x={420} y={318} width={38} height={30} rx={5} fill={C.green} />
      <SvgText x={439} y={340} size={18} weight={800} fill="#FFFFFF">03</SvgText>
      <SvgText x={468} y={340} size={18} weight={800} fill={C.green} anchor="start">冷冻站主区域</SvgText>

      <Room x={320} y={300} w={95} h={425} fill="#F7FBFF" />
      <line x1={320} y1={360} x2={415} y2={360} stroke={C.blueMain} strokeWidth={2} />
      <line x1={320} y1={675} x2={415} y2={675} stroke={C.blueMain} strokeWidth={2} />
      <SvgText x={368} y={466} size={20} weight={800}>A-150</SvgText>
      <SvgText x={368} y={494} size={15}>冷站配电间</SvgText>
      <LightningIcon x={352} y={515} />

      <Room x={1280} y={300} w={100} h={425} fill="#F7FBFF" />
      <line x1={1280} y1={360} x2={1380} y2={360} stroke={C.blueMain} strokeWidth={2} />
      <line x1={1280} y1={675} x2={1380} y2={675} stroke={C.blueMain} strokeWidth={2} />
      <SvgText x={1330} y={466} size={20} weight={800}>A-124</SvgText>
      <SvgText x={1330} y={494} size={15}>冷站配电间</SvgText>
      <LightningIcon x={1313} y={515} />

      <Room x={410} y={725} w={250} h={75} />
      <ComputerIcon x={490} y={745} />
      <SvgText x={555} y={770} size={18} anchor="start">控制室</SvgText>
      <Room x={660} y={725} w={210} h={75} />
      <SvgText x={765} y={770} size={18}>工具间</SvgText>
      <Room x={870} y={725} w={70} h={75} />
      <Room x={940} y={725} w={250} h={75} />
      <GearIcon x={1010} y={762} />
      <SvgText x={1095} y={770} size={18} anchor="start">备件间</SvgText>
      <Room x={1190} y={725} w={190} h={75} />
      <CleaningIcon x={1230} y={750} />
      <SvgText x={1300} y={770} size={18}>清洁间</SvgText>
    </g>
  );
}

function DoorsLayer() {
  return (
    <g id="layer-doors">
      <SingleDoor x={302} y={260} size={50} direction="left-down" />
      <SingleDoor x={68} y={704} size={48} direction="down-right" />
      <SingleDoor x={185} y={704} size={48} direction="right-down" />
      <SingleDoor x={392} y={222} size={48} direction="down-right" />
      <SingleDoor x={760} y={222} size={48} direction="down-left" />
      <SingleDoor x={1230} y={222} size={48} direction="down-left" />
      <SingleDoor x={1404} y={232} size={44} direction="down-right" />
      <SingleDoor x={1435} y={310} size={48} direction="down-right" />
      <SingleDoor x={1435} y={520} size={48} direction="down-right" />
      <SingleDoor x={1435} y={550} size={48} direction="down-right" />
      <SingleDoor x={415} y={645} size={48} direction="right-down" />
      <SingleDoor x={1280} y={642} size={48} direction="right-down" />
      <DoubleDoor />
      <Star cx={835} cy={276} />
      <SvgText x={858} y={283} size={18} weight={800} anchor="start">你的位置</SvgText>
    </g>
  );
}

function EquipmentLayer() {
  return (
    <g id="layer-equipment">
      <SecondaryPump x={430} y={430} />
      <EquipmentGroup x={505} y={365} />
      <EquipmentGroup x={625} y={365} />
      <EquipmentGroup x={745} y={365} />
      <SecondaryPump x={850} y={430} />
      <EquipmentGroup x={925} y={365} />
      <EquipmentGroup x={1045} y={365} />
      <EquipmentGroup x={1165} y={365} />
    </g>
  );
}

function ValvesLayer() {
  const { left, right } = VALVE_CALLOUTS;

  return (
    <g id="layer-valves">
      <g id="valve-callout-left" data-movable="true" transform="translate(0 0)">
        <SvgText x={left.textX} y={left.textY} size={18} weight={800} fill={C.green} anchor="start">
          自动排气阀
        </SvgText>
        <path
          d={`M${left.lineStartX} ${left.lineStartY} L${left.lineEndX} ${left.lineEndY}`}
          stroke={C.green}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          fill="none"
          markerEnd="url(#valveArrow)"
        />
      </g>
      <g id="valve-callout-right" data-movable="true" transform="translate(0 0)">
        <SvgText x={right.textX} y={right.textY} size={18} weight={800} fill={C.green} anchor="start">
          自动排气阀
        </SvgText>
      </g>
    </g>
  );
}

function LegendLayer() {
  return (
    <g id="layer-legend">
      <rect x={24} y={832} width={1624} height={74} rx={12} fill="#FFFFFF" stroke={C.borderLight} strokeWidth={1.5} />
      <g fontSize={15} fontWeight={700} fill={C.textBlue}>
        <rect x={45} y={855} width={32} height={22} fill="#FFFFFF" stroke={C.blueMain} />
        <SvgText x={90} y={873} size={15} anchor="start">房间区域</SvgText>
        <rect x={175} y={852} width={32} height={28} fill="#FFFFFF" stroke={C.blueMain} />
        <SvgText x={220} y={873} size={15} anchor="start">设备单元</SvgText>
        <rect x={300} y={850} width={34} height={34} fill="#FFFFFF" stroke={C.device} />
        <SvgText x={317} y={874} size={15} fill="#111111">泵</SvgText>
        <SvgText x={348} y={873} size={15} anchor="start">泵</SvgText>
        <rect x={390} y={846} width={40} height={40} fill="#FFFFFF" stroke={C.device} />
        <SvgText x={410} y={871} size={14} fill="#111111">板换</SvgText>
        <SvgText x={444} y={873} size={15} anchor="start">板换</SvgText>
        <rect x={520} y={846} width={44} height={40} fill="#FFFFFF" stroke={C.device} />
        <SvgText x={542} y={871} size={14} fill="#111111">冷机</SvgText>
        <SvgText x={578} y={873} size={15} anchor="start">冷机</SvgText>
        <rect x={635} y={840} width={38} height={54} fill="#FFFFFF" stroke={C.device} />
        <SvgText x={654} y={861} size={13} fill="#111111">二</SvgText>
        <SvgText x={654} y={878} size={13} fill="#111111">次</SvgText>
        <SvgText x={654} y={895} size={13} fill="#111111">泵</SvgText>
        <SvgText x={688} y={873} size={15} anchor="start">二次泵</SvgText>
        <line x1={780} y1={865} x2={825} y2={865} stroke={C.blueMain} strokeWidth={4} />
        <SvgText x={838} y={873} size={13} anchor="start">蓝色供线 / 冷冻供水</SvgText>
        <line x1={973} y1={865} x2={1018} y2={865} stroke={C.red} strokeWidth={4} />
        <SvgText x={1030} y={873} size={13} anchor="start">红色回线 / 冷冻回水</SvgText>
        <circle cx={1164} cy={865} r={8} fill={C.green} />
        <SvgText x={1182} y={873} size={13} anchor="start">自动排气阀</SvgText>
        <SafetyExitIcon x={1288} y={850} size={30} />
        <SvgText x={1326} y={873} size={13} anchor="start">安全出口</SvgText>
        <g transform="translate(1395 850) scale(0.7)">
          <SingleDoor x={0} y={0} size={46} direction="right-down" />
        </g>
        <SvgText x={1440} y={873} size={13} anchor="start">门/出入口</SvgText>
        <Star cx={1535} cy={865} r={13} />
        <SvgText x={1554} y={873} size={13} anchor="start">你的位置</SvgText>
      </g>
    </g>
  );
}

function ExhaustValveMapPage() {
  const scale = useStageScale();
  const principal = useAccess();
  if (isProfessionalBusinessPrincipal(principal) && !canPerformBusinessAction(principal, { module: 'exhaust_valves', action: 'read', building: 'A楼', specialty: '暖通' })) return <p role="alert" className="p-6 text-muted-foreground">当前账号无A楼冷冻站图纸访问权限</p>;

  return (
    <main className="flex min-h-[calc(100dvh-var(--global-navigation-height,0px))] items-start justify-start overflow-auto bg-[#F6FAFF]">
      <div style={{ width: DESIGN_WIDTH * scale, height: DESIGN_HEIGHT * scale }} className="shrink-0">
        <svg
          width={DESIGN_WIDTH}
          height={DESIGN_HEIGHT}
          viewBox={`0 0 ${DESIGN_WIDTH} ${DESIGN_HEIGHT}`}
          role="img"
          aria-label="A-127 冷冻站平面布置示意图"
          style={{
            display: 'block',
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            fontFamily:
              '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", Arial, sans-serif',
          }}
        >
          <g id="layer-bg">
            <rect x={0} y={0} width={1672} height={941} fill="#FFFFFF" />
            <rect x={0} y={108} width={1672} height={833} fill="#F7FAFF" opacity={0.35} />
          </g>
          <HeaderLayer />
          <RoomsLayer />
          <DoorsLayer />
          <g id="layer-equipment-bg" />
          <EquipmentLayer />
          <g id="layer-pipes" />
          <ValvesLayer />
          <g id="layer-icons" />
          <LegendLayer />
        </svg>
      </div>
    </main>
  );
}

export default ExhaustValveMapPage;
