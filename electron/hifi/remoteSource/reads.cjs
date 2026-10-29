'use strict';

// Sanitized input evidence: native clock feedback alone cannot prove that a reopened decoder sought.
const createInputEvidence = () => {
    const state = { requestId: 0, rangeReadId: 0, fullReadId: 0, seekable: false };
    return {
        read: () => ({ ...state }),
        open: ({ start, end, total, seekable }) => {
            const id = ++state.requestId;
            state.seekable = seekable;
            let received = 0;
            return {
                write: length => { received += length; if (start > 0 && length > 0) state.rangeReadId = Math.max(state.rangeReadId, id); },
                end: () => {
                    if (start === 0 && total > 0 && end === total && received === total) state.fullReadId = Math.max(state.fullReadId, id);
                },
            };
        },
    };
};
module.exports = { createInputEvidence };
