export const ENCODINGS = [
    {
        "instructionId": "movprfx_z_z",
        "encodingId": "movprfx_z_z_",
        "mnemonic": "MOVPRFX",
        "className": "SVE",
        "fileName": "movprfx_z_z.xml",
        "mask": 4294966272,
        "value": 69254144,
        "bitCount": 22,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-movprfx"
    }
];
