export const ENCODINGS = [
    {
        "instructionId": "movprfx_z_p_z",
        "encodingId": "movprfx_z_p_z_",
        "mnemonic": "MOVPRFX",
        "className": "SVE",
        "fileName": "movprfx_z_p_z.xml",
        "mask": 4282310656,
        "value": 68165632,
        "bitCount": 16,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 17,
                "width": 2
            },
            {
                "name": "M",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
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
        "operandFamilyId": "sve-predicated-movprfx"
    }
];
