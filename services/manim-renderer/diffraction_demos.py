"""Fraunhofer optics fixtures using sourced equations and the generic compositor."""

SLIT_INTENSITY = "sinc(pi*x)^2"
GRATING_ENVELOPE = "sinc(0.24*pi*x)^2"
# At u = d sin(theta)/lambda, pair equal and opposite phase terms for
# sources at -2d, -d, 0, d and 2d. Normalize power to the central order.
GRATING_INTENSITY = "((1+2*cos(2*pi*x)+2*cos(4*pi*x))/5)^2*" + GRATING_ENVELOPE


def diffraction_demos(obj, beat, plan, blue, gold, rose):
    slit = plan(
        "Fraunhofer single-slit diffraction",
        "Relate the aperture width to phase differences in the far field",
        [
            obj("heading", "text", text="Single slit · far-field geometry", size=4.4, at=[0, 3]),
            obj("upper", "rectangle", size=.3, height=1.9, at=[-1.7, 1.48], color=blue),
            obj("lower", "rectangle", size=.3, height=1.9, at=[-1.7, -1.48], color=blue),
            obj("aperture", "equation", text="a", at=[-2.2, 0], color=gold),
            obj("plane", "text", text="Plane-wave incidence", size=2.8, at=[-4.2, -1.55]),
            obj("frontA", "line", points=[[-5.4, 1.18], [-5.4, -1.15]], color=blue),
            obj("frontB", "line", points=[[-4.82, 1.18], [-4.82, -1.15]], color=blue),
            obj("frontC", "line", points=[[-4.24, 1.18], [-4.24, -1.15]], color=blue),
            obj("incident", "arrow", points=[[-4.0, 0], [-2.65, 0]], color=blue),
            obj("normal", "line", points=[[-1.5, 0], [4.9, 0]], color="#8897AD"),
            obj("rayA", "arrow", points=[[-1.6, .48], [3.95, 1.73]], color=gold),
            obj("rayB", "arrow", points=[[-1.6, -.48], [3.95, .77]], color=gold),
            obj("angle", "equation", text=r"\theta", at=[2.81, .31], color=gold),
            obj("pathDifference", "equation", text=r"\Delta L = a\sin\theta", at=[1.6, -1.03], size=4.8),
            obj("farField", "text", text="Parallel rays toward a distant observation point", at=[1.25, -2.55], size=3.1),
        ],
        [
            beat(1.5, ("fadeIn", "heading"), ("create", "upper"), ("create", "lower"), ("write", "aperture"),
                 narration="Monochromatic light illuminates a slit of width a."),
            beat(1.7, ("create", "frontA"), ("create", "frontB"), ("create", "frontC"), ("create", "incident"),
                 ("fadeIn", "plane"), narration="At normal incidence, the aperture is initially in phase."),
            beat(2.0, ("create", "normal"), ("create", "rayA"), ("create", "rayB"), ("write", "angle"),
                 ("fadeIn", "farField"), narration="In the far field, the rays toward the observation direction are nearly parallel."),
            beat(2.2, ("write", "pathDifference"),
                 narration="The two edges differ in path length by a times the sine of theta."),
            {"seconds": .8},
        ],
    )
    intensity = plan(
        "Intensity distribution and minima",
        "Locate the central maximum and integer minima of a normalized sinc-squared pattern",
        [
            obj("heading", "text", text="Why the dark fringes appear", size=4.5, at=[0, 3.22]),
            obj("density", "axes", xRange=[-3.5, 3.5], yRange=[0, 1.12], at=[0, -.35], size=10, height=3.92),
            obj("curve", "graph", axes="density", expression=SLIT_INTENSITY, color=blue),
            obj("law", "equation", text=r"I/I_0=\left(\frac{\sin(\pi u)}{\pi u}\right)^2", size=4.3, at=[0, 2.38]),
            obj("ylabel", "equation", text=r"I/I_0", size=3.4, at=[-6.15, 1.47]),
            obj("xlabel", "text", text="u = a sin θ / λ", size=3.3, at=[4.55, -2.9]),
            obj("minima", "equation", text=r"u=\pm1,\pm2,\pm3", color=gold, size=4.1, at=[0, -2.95]),
        ],
        [
            beat(1.5, ("fadeIn", "heading"), ("create", "density"), ("write", "ylabel"), ("write", "xlabel"),
                 narration="Use slit width times sine theta, measured in wavelengths, as the horizontal coordinate."),
            beat(2.0, ("create", "curve"), ("write", "law"),
                 narration="At zero angle, the sinc-squared function tends to one."),
            beat(1.8, ("write", "minima"),
                 narration="Nonzero integer values of u give dark fringes. Zero is the central maximum."),
            {"seconds": 1},
        ],
    )
    grating = plan(
        "Plane diffraction grating",
        "Separate the slit envelope from interference across five identical slits",
        [
            obj("heading", "text", text="Five equally spaced slits", size=4.5, at=[0, 3.18]),
            obj("density", "axes", xRange=[-2.5, 2.5], yRange=[0, 1.12], size=10, height=3.5, at=[0, -.5]),
            obj("envelope", "graph", axes="density", expression=GRATING_ENVELOPE, color=gold),
            obj("power", "graph", axes="density", expression=GRATING_INTENSITY, color=blue),
            obj("ratio", "text", text="Slit width / spacing = 0.24", size=2.8, at=[0, 2.48]),
            obj("envLabel", "text", text="Single-slit envelope", color=gold, size=3, at=[-3.35, -2.65]),
            obj("powerLabel", "text", text="Grating intensity", color=blue, size=3, at=[3.35, -2.65]),
            obj("orders", "text", text="u = d sin θ / λ, principal orders u = m", size=3.1, at=[0, -3.28], color=rose),
        ],
        [
            beat(1.4, ("fadeIn", "heading"), ("fadeIn", "ratio"), ("create", "density"),
                 narration="Consider five identical, equally illuminated slits at normal incidence."),
            beat(1.6, ("create", "envelope"), ("fadeIn", "envLabel"),
                 narration="The finite width of each slit contributes the gold envelope."),
            beat(1.8, ("create", "power"), ("fadeIn", "powerLabel"),
                 narration="The blue curve multiplies the envelope by the normalized five-slit interference factor."),
            beat(1.8, ("write", "orders"),
                 narration="At integer values of u, neighboring slits are in phase and produce the principal orders."),
            {"seconds": 1},
        ],
    )
    return {"fraunhofer-slit": slit, "diffraction-intensity": intensity, "plane-grating": grating}
