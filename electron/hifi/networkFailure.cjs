'use strict';

const { isNetworkFailureMessage } = require('../../shared/networkErrorText.cjs');

// Classify transport failures without confusing media, authentication or device errors with outages.
const retryableStatus = status => status === 408 || status === 429 || status >= 500 && status <= 599;
const networkFailure = error => {
    const seen = new Set();
    for (let current = error; current && !seen.has(current); current = current.cause) {
        seen.add(current);
        const text = `${current.code ?? ''} ${current.message ?? ''}`;
        if (isNetworkFailureMessage(text) || /UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_(RESET|CLOSED|TIMED_OUT|REFUSED|ABORTED)|NAME_NOT_RESOLVED|TIMED_OUT|CONTENT_LENGTH_MISMATCH|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR)|ERR_STREAM_PREMATURE_CLOSE/i.test(text)) return true;
    }
    return false;
};
module.exports = { networkFailure, retryableStatus };
