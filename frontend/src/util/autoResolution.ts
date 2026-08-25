export interface Resolution {
    width: number;
    height: number;
}

/** Fit the bounding-box aspect ratio into the selected square-equivalent area. */
export function calculateAutoResolution(
    boxWidth: number,
    boxHeight: number,
    baseWidth: number,
    step: number,
): Resolution {
    if (
        !Number.isFinite(boxWidth) ||
        !Number.isFinite(boxHeight) ||
        !Number.isFinite(baseWidth) ||
        !Number.isFinite(step) ||
        boxWidth <= 0 ||
        boxHeight <= 0 ||
        baseWidth <= 0 ||
        step <= 0
    ) {
        throw new RangeError("Auto-resolution inputs must be positive numbers");
    }

    const ratio = boxWidth / boxHeight;
    const baseArea = baseWidth ** 2;
    if (ratio === 1) {
        const size = roundToStep(baseWidth, step);
        return { width: size, height: size };
    }

    if (ratio > 1) {
        const idealWidth = Math.sqrt(baseArea * ratio);
        const idealHeight = idealWidth / ratio;
        return {
            width: floorToStep(idealWidth, step),
            height: roundToStep(idealHeight, step),
        };
    }

    const idealHeight = Math.sqrt(baseArea / ratio);
    const idealWidth = idealHeight * ratio;
    return {
        width: roundToStep(idealWidth, step),
        height: floorToStep(idealHeight, step),
    };
}

function roundToStep(value: number, step: number): number {
    return Math.max(step, Math.round(value / step) * step);
}

function floorToStep(value: number, step: number): number {
    return Math.max(step, Math.floor(value / step) * step);
}
