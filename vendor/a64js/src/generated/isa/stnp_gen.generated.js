export const ENCODINGS = [
    {
        "instructionId": "STNP_gen",
        "encodingId": "STNP_32_ldstnapair_offs",
        "mnemonic": "STNP",
        "className": "Signed offset",
        "fileName": "stnp_gen.xml",
        "mask": 4290772992,
        "value": 671088640,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
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
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "STNP_gen",
        "encodingId": "STNP_64_ldstnapair_offs",
        "mnemonic": "STNP",
        "className": "Signed offset",
        "fileName": "stnp_gen.xml",
        "mask": 4290772992,
        "value": 2818572288,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
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
        "operandFamilyId": "pair-load-store"
    }
];
