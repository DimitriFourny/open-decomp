export const ENCODINGS = [
    {
        "instructionId": "LDXRB",
        "encodingId": "LDXRB_LR32_ldstexclr",
        "mnemonic": "LDXRB",
        "className": "No offset",
        "fileName": "ldxrb.xml",
        "mask": 4292902912,
        "value": 138412032,
        "bitCount": 12,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "o0",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
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
        "operandFamilyId": "load-exclusive"
    }
];
