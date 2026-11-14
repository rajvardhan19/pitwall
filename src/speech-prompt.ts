// What the on-device transcriber is told to expect. Whisper takes a text prompt as earlier context
// and leans toward its words, which matters for names and radio jargon (“Theo”, “hards”, “Keller”).
// Built from the roster, so renamed drivers stay covered.
import { ROSTER } from './roster.ts';

const RIVALS = ROSTER.filter(d => d.id !== 1 && d.id !== 4).map(d => d.name.split(' ').slice(1).join(' '));

export const SPEECH_PROMPT =
  ' Theo, Nico, car one, car two. Box, box this lap, stay out, push, conserve, lift and coast, let Nico through, let Theo through, both cars.' +
  ` Softs, mediums, hards, inters, tyres, gap, laps left, pitting. ${RIVALS.join(', ')}.`;
