export const ENCODINGS = [
    {
        "instructionId": "DC_SYS",
        "encodingId": "DC_SYS_CR_systeminstrs",
        "mnemonic": "SYS",
        "className": "System",
        "fileName": "dc_sys.xml",
        "mask": 4294504448,
        "value": 3574099968,
        "bitCount": 17,
        "fields": [
            {
                "name": "L",
                "lsb": 21,
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
        "canonicalEncodingId": "SYS_CR_systeminstrs",
        "canonicalFileName": "sys.xml",
        "operandFamilyId": "system-instruction-alias-dc-sys"
    }
];
