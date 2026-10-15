export const ENCODINGS = [
    {
        "instructionId": "DMB",
        "encodingId": "DMB_BO_barriers",
        "mnemonic": "DMB",
        "className": "System",
        "fileName": "dmb.xml",
        "mask": 4294963455,
        "value": 3573756095,
        "bitCount": 28,
        "fields": [
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "opc",
                "lsb": 5,
                "width": 2
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "barrier"
    }
];
