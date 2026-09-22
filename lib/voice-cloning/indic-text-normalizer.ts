const TERMS: Record<string, { hi: string; mr: string }> = {
  'neural networks': { hi: 'न्यूरल नेटवर्क', mr: 'न्यूरल नेटवर्क' },
  'neural network': { hi: 'न्यूरल नेटवर्क', mr: 'न्यूरल नेटवर्क' },
  'training process': { hi: 'ट्रेनिंग प्रक्रिया', mr: 'ट्रेनिंग प्रक्रिया' },
  'loss function': { hi: 'लॉस फंक्शन', mr: 'लॉस फंक्शन' },
  'gradient descent': { hi: 'ग्रेडिएंट डिसेंट', mr: 'ग्रेडियंट डिसेंट' },
  'internal weights': { hi: 'इंटरनल वेट्स', mr: 'इंटरनल वेट्स' },
  backpropagation: { hi: 'बैकप्रोपेगेशन', mr: 'बॅकप्रोपेगेशन' },
  prediction: { hi: 'प्रेडिक्शन', mr: 'प्रेडिक्शन' },
  training: { hi: 'ट्रेनिंग', mr: 'ट्रेनिंग' },
};

// Longest phrases first; Unicode boundaries leave adjacent Indic words intact.
const pattern = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}_])(?:${Object.keys(TERMS)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/ /g, '\\s+'))
    .join('|')})(?![\\p{L}\\p{M}\\p{N}_])`,
  'giu',
);

export function normalizeIndicTeachingText(text: string, language: string): string {
  if (language !== 'hi' && language !== 'mr') return text;
  return text.replace(pattern, (term) => TERMS[term.toLowerCase().replace(/\s+/g, ' ')][language]);
}
