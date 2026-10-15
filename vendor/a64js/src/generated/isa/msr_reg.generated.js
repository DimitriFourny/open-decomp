export const ENCODINGS = [
    {
        "instructionId": "MSR_reg",
        "encodingId": "MSR_SR_systemmove",
        "mnemonic": "MSR",
        "className": "System",
        "fileName": "msr_reg.xml",
        "mask": 4293918720,
        "value": 3574595584,
        "bitCount": 12,
        "fields": [
            {
                "name": "L",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "o0",
                "lsb": 19,
                "width": 1
            },
            {
                "name": "op1",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "CRn",
                "lsb": 12,
                "width": 4
            },
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 5,
                "width": 3
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
        "operandFamilyId": "system-move"
    }
];
