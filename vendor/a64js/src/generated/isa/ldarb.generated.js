export const ENCODINGS = [
    {
        "instructionId": "LDARB",
        "encodingId": "LDARB_LR32_ldstord",
        "mnemonic": "LDARB",
        "className": "No offset",
        "fileName": "ldarb.xml",
        "mask": 4292902912,
        "value": 146833408,
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
