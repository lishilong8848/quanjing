import type { ProfessionalSpecialty } from '../../../shared/professional-access';

export const PROFESSIONAL_DEFAULTS: ReadonlyArray<{ name: string; openId: string; specialties: ProfessionalSpecialty[] }> = [
  { name: '周海祥', openId: 'ou_00e4670ccd913f3bc4f2821f00a574cc', specialties: ['电气'] },
  { name: '王庆华', openId: 'ou_fd6a4bdbb811ca6247ae492bf2b5e7f8', specialties: ['暖通'] },
  { name: '曹毅', openId: 'ou_5a4c9222affb2062a1f0d4f167181121', specialties: ['弱电'] },
  { name: '高荣', openId: 'ou_0e3ade873ee4d95533919427546c100b', specialties: ['消防', 'EHS'] },
  { name: '明志勇', openId: 'ou_4fa470cbe21075fb274583fdf0dee727', specialties: ['消防', 'EHS'] },
];
