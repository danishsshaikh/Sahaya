export const manimDiagnosticTasks = {
  'number-line': {
    title: 'A point moves along a number line',
    description: 'Show a number line, then animate a dot from zero to two.',
    keyPoints: ['Use two short named cues.', 'Keep the numbers visible as the dot moves.'],
  },
  'function-plot': {
    title: 'A point follows a plotted quadratic',
    description: 'Plot y = x² on labelled axes and animate a point along the curve.',
    keyPoints: [
      'Use named cues for the axes and motion.',
      'The point should stay on the function.',
    ],
  },
  'wave-interference': {
    title: 'Two waves interfere',
    description:
      'Show equal-amplitude sine waves and their sum while changing the relative phase from zero to π radians.',
    keyPoints: [
      'Explain constructive and destructive interference.',
      'Keep a consistent illustrative amplitude scale.',
    ],
  },
  'single-slit-diffraction': {
    title: 'Animated Diffraction Visualization: single-slit far-field pattern',
    teachingObjective:
      'Explain how slit width changes the angular spread of a monochromatic diffraction pattern.',
    description:
      'Build a classroom visualization that connects a slit and observation screen to an intensity graph. Use the Fraunhofer single-slit model at a fixed wavelength of 550 nm. Compare slit widths of 20 and 10 micrometers on a common angular axis near the central maximum. Use normalized intensity with a maximum of one at zero angle.',
    keyPoints: [
      'Define the variable u = a sin(theta) / lambda, with a the slit width and theta the observation angle.',
      'Use I/I0 = (sin(pi u)/(pi u)) squared, with the continuous limit I/I0 = 1 at u = 0.',
      'Identify the first minima at u = ±1 and explain why the narrower slit has a wider central lobe in angle.',
      'Keep the diagram illustrative and use stable axes and a restrained number of readable labels.',
      'Connect the slit and intensity graph in distinct narration cues and keep the wavelength constant in the comparison.',
    ],
  },
};
